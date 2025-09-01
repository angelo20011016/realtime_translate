import os
import json
import logging
import time
import sys
from pathlib import Path
import threading
import re # Import re for safe folder name generation

from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS # Import CORS

import google.generativeai as genai
import azure.cognitiveservices.speech as speechsdk

# --- Setup logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Load environment variables ---
load_dotenv()

# --- Flask and SocketIO Initialization ---
app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'a-very-secret-key-for-development')
socketio = SocketIO(app, cors_allowed_origins="*") # Allow all origins for Socket.IO communication

# Enable CORS for Flask routes, specifically for API endpoints
# You might want to restrict origins in a production environment
CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app, resources={r"/*": {"origins": "*"}}) # Broad CORS for all routes if needed

# --- Gemini API Configuration ---
try:
    gemini_api_key = os.environ["GEMINI_API_KEY"]
    genai.configure(api_key=gemini_api_key)
    # Using Gemini 2.5 Flash Lite for speed, adjust if higher accuracy is needed and latency is acceptable.
    generation_config = genai.types.GenerationConfig(
        candidate_count=1,
        stop_sequences=["\n"], 
        max_output_tokens=150, 
        temperature=0.5, # Lower temperature for accuracy, adjust if too "robotic"
    )
    model = genai.GenerativeModel(model_name="gemini-2.5-flash-lite", generation_config=generation_config)
except KeyError:
    logging.error("GEMINI_API_KEY not found in .env file. Please add it.")
    # You might want to exit or handle this more gracefully in a real application
    # raise RuntimeError("GEMINI_API_KEY not found in .env file. Please add it.")
    # For now, set model to None if key is missing to avoid crashing immediately on startup
    model = None 

# --- Azure Speech SDK Configuration ---
try:
    speech_key = os.environ["AZURE_SPEECH_KEY"]
    speech_region = os.environ["AZURE_SPEECH_REGION"]
except KeyError:
    logging.error("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not found in .env file. Please add them.")
    # raise RuntimeError("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not found in .env file. Please add them.")
    # For now, set config to None if keys are missing
    speech_config = None
    speech_key = None
    speech_region = None

# --- Language and Voice Configuration ---
LANGUAGE_VOICES = {
    "en-US": "en-US-JennyNeural",
    "zh-TW": "zh-TW-HsiaoChenNeural",
    "ja-JP": "ja-JP-NanamiNeural"
}
LANGUAGE_NAMES = {
    "en-US": "English",
    "zh-TW": "Traditional Chinese",
    "ja-JP": "Japanese"
}

# --- Global state for clients ---
# Dictionary to hold recognizer and settings for each client's session
# Format: {sid: {'recognizer': ..., 'stream': ..., 'source_lang': ..., 'target_lang': ..., 'tts_enabled': ...}}
clients = {}

# --- Helper Functions ---

def get_translation_prompt(text, target_lang_code):
    """
    Generates a prompt for the Gemini model, prioritizing Traditional Chinese (Taiwan).
    Ensures natural, colloquial, and accurate translation, avoiding non-target dialects/scripts.
    """
    target_language_name = LANGUAGE_NAMES.get(target_lang_code, "the target language")
    
    if target_lang_code == "zh-TW":
        prompt = (
            f"You are an expert translator specializing in Taiwanese Mandarin (Traditional Chinese).\n"
            f"Your task is to translate the following spoken input into natural, colloquial, and idiomatic "
            f"Taiwanese Mandarin (Traditional Chinese).\n"
            f"The input may be fragmented, contain pauses, or have ungrammatical phrasing due to real-time speech.\n"
            f"Your goal is to produce a fluent and contextually accurate translation. Avoid using Simplified Chinese characters, "
            f"Cantonese colloquialisms, or any overly formal language.\n\n"
            f"Input speech: '{text}'\n\n"
            f"Please provide ONLY the translated sentence in Traditional Chinese. Do not include any explanations, "
            f"notes, or introductory phrases like 'Here is the translation:'.\n"
            f"Translated sentence:"
        )
    else: # General prompt for other languages
        prompt = (
            f"You are an expert in oral translation. Your task is to translate the user's input into natural, "
            f"colloquial {target_language_name}. The user's input might be fragmented or ungrammatical because it's from real-time speech. "
            f"Refine it and provide a fluent translation. "
            f"Input: '{text}'\n"
            f"Please return only the translated sentence, without any explanation or extra text."
        )
    
    return prompt

def synthesize_speech(text, lang_code, sid):
    """Synthesizes text to speech using Azure Speech SDK and sends audio to client."""
    if not speech_config or not speech_key:
        logging.warning(f"Azure Speech SDK not configured. Cannot synthesize speech for sid {sid}.")
        return

    try:
        voice_name = LANGUAGE_VOICES.get(lang_code)
        if not voice_name:
            logging.warning(f"No voice configured for language {lang_code} for sid {sid}")
            return

        # Create a new synthesizer instance for each synthesis request
        # This is safer than reusing a single instance with changing configs.
        synthesis_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
        synthesis_config.speech_synthesis_voice_name = voice_name
        
        # Use audio_config=None to get audio data in memory
        synthesizer = speechsdk.SpeechSynthesizer(speech_config=synthesis_config, audio_config=None)
        
        result = synthesizer.speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logging.info(f"Speech synthesis successful for sid {sid}.")
            # Emit the audio data directly to the client
            # The client will need to handle playing this raw audio data
            socketio.emit('audio_synthesis_result', {'audio': result.audio_data}, room=sid)
        else:
            cancellation = result.cancellation_details
            logging.error(f"Speech synthesis failed for sid {sid}: Reason={cancellation.reason}")
            if cancellation.reason == speechsdk.CancellationReason.Error:
                logging.error(f"Error details: {cancellation.error_details}")

    except Exception as e:
        logging.error(f"Exception during speech synthesis for sid {sid}: {e}")

def handle_final_recognition(evt, sid):
    """Handles final recognition results, translates, and optionally synthesizes speech."""
    text = evt.result.text
    
    # Check recognition result status
    if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
        if not text: # Ignore empty recognition results
            logging.debug(f"Received empty final recognition result for sid {sid}.")
            return
    elif evt.result.reason == speechsdk.ResultReason.NoMatch:
        logging.info(f"No speech could be recognized for sid {sid}.")
        # Optionally emit a message to the client indicating no speech was detected
        return
    elif evt.result.reason == speechsdk.ResultReason.Canceled:
        cancellation_details = evt.result.cancellation_details
        logging.error(f"Recognition canceled for sid {sid}: Reason={cancellation_details.reason}")
        error_message = "Speech recognition failed."
        if cancellation_details.reason == speechsdk.CancellationReason.Error:
            error_details = cancellation_details.error_details
            logging.error(f"Error details for sid {sid}: {error_details}")
            # Provide more user-friendly error messages for common issues
            if "authentication" in error_details.lower() or "subscription" in error_details.lower():
                error_message = "Azure authentication failed. Check API key or subscription status."
            elif "websocket" in error_details.lower() or "connection" in error_details.lower():
                error_message = "Network connection issue with Azure service."
            elif "invalid language" in error_details.lower():
                error_message = f"Azure Speech: Invalid language code '{clients.get(sid, {}).get('source_lang', 'unknown')}'. Please check the selected language."
        
        # Emit the error to the specific client
        socketio.emit('server_error', {"error": error_message}, room=sid)
        cleanup_client(sid) # Clean up resources after an error
        return

    # --- Process recognized and translated text ---
    client_info = clients.get(sid)
    if not client_info:
        logging.warning(f"Client info not found for sid {sid}. Cannot process recognition result.")
        return

    target_lang = client_info['target_lang']
    tts_enabled = client_info['tts_enabled']

    try:
        # Get the translation prompt
        prompt = get_translation_prompt(text, target_lang)
        
        # Generate translation using Gemini
        if model: # Check if model was successfully initialized
            response = model.generate_content(prompt)
            refined_text = response.text.strip()
            logging.info(f"Translated text for sid {sid}: '{refined_text}'")
            
            # Emit the original and translated text to the client
            socketio.emit('final_result', {
                "original": text,
                "refined": refined_text
            }, room=sid)

            # Synthesize speech if TTS is enabled
            if tts_enabled:
                synthesize_speech(refined_text, target_lang, sid)
        else:
            logging.error("Gemini model not available. Cannot perform translation.")
            socketio.emit('server_error', {"error": "Translation service is unavailable."}, room=sid)

    except Exception as e:
        logging.error(f"Error processing recognition result for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "An error occurred during translation. Please try again."}, room=sid)


# --- Flask Routes ---

@app.route('/')
def index():
    """Serves the main HTML page."""
    # Assumes index.html is in a 'templates' folder
    try:
        return render_template('index.html')
    except Exception as e:
        logging.error(f"Error rendering index.html: {e}")
        return f"Error rendering index.html: {e}. Ensure 'templates/index.html' exists.", 500


@app.route('/status')
def get_status():
    """Provides a general status of the backend. Frontend might poll this."""
    # This provides a high-level status. Detailed status might come via Socket.IO.
    return jsonify(current_status)

# --- Socket.IO Event Handlers ---

@socketio.on('connect')
def handle_connect():
    """Handles a new client connection via Socket.IO."""
    sid = request.sid
    logging.info(f"Client connected via Socket.IO: {sid}")
    # Optionally emit initial client settings or status

@socketio.on('start_translation')
def handle_start_translation(data):
    """
    Handles the client's request to start translation.
    Initializes the Azure Speech Recognizer for the client.
    """
    sid = request.sid
    
    # --- Safety Check: Clean up previous session if any ---
    if sid in clients:
        logging.warning(f"Existing session found for {sid}. Cleaning up before starting new one.")
        cleanup_client(sid)

    # --- Get client settings ---
    source_lang = data.get('sourceLanguage', 'en-US') # Default to English
    target_lang = data.get('targetLanguage', 'zh-TW') # Default to Traditional Chinese
    tts_enabled = data.get('ttsEnabled', False)

    logging.info(f"Starting translation for sid {sid}: Source={source_lang}, Target={target_lang}, TTS={tts_enabled}")

    # --- Initialize Azure Speech Recognizer for this client ---
    if not speech_config or not speech_key:
        logging.error("Azure Speech SDK is not configured. Cannot start translation.")
        socketio.emit('server_error', {"error": "Speech service is unavailable. Please check server configuration."}, room=sid)
        return

    try:
        # Create speech config for this client (e.g., for recognition language)
        client_speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
        client_speech_config.speech_recognition_language = source_lang
        
        # Create a push stream to send audio data from the client
        push_stream = speechsdk.audio.PushAudioInputStream()
        audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
        
        # Create the speech recognizer
        speech_recognizer = speechsdk.SpeechRecognizer(speech_config=client_speech_config, audio_config=audio_config)

        # Store client-specific objects and settings
        clients[sid] = {
            'recognizer': speech_recognizer,
            'stream': push_stream,
            'source_lang': source_lang,
            'target_lang': target_lang,
            'tts_enabled': tts_enabled,
            'speech_config': client_speech_config, # Store config if needed for re-initialization
            'audio_config': audio_config # Store audio config
        }

        # --- Connect event handlers ---
        # 'recognizing' event for interim results
        speech_recognizer.recognizing.connect(lambda evt: (
            socketio.emit('interim_result', {'text': evt.result.text}, room=sid),
            logging.debug(f"Recognizing for {sid}: {evt.result.text}")
        ))
        # 'recognized' event for final results
        speech_recognizer.recognized.connect(lambda evt: handle_final_recognition(evt, sid))
        
        # Other events for session status (optional for basic functionality)
        speech_recognizer.session_stopped.connect(lambda evt: logging.info(f"Session stopped for sid {sid}."))
        speech_recognizer.canceled.connect(lambda evt: logging.info(f"Canceled event for sid {sid}."))
        
        # --- Start continuous recognition ---
        speech_recognizer.start_continuous_recognition()
        logging.info(f"Speech recognition started for sid {sid}.")

    except Exception as e:
        logging.error(f"Failed to initialize Azure Speech Recognizer for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "Failed to initialize speech recognition service. Check settings and permissions."})
        cleanup_client(sid) # Clean up if initialization failed


@socketio.on('settings_changed')
def handle_settings_changed(data):
    """Handles changes in language or TTS settings from the client while recording."""
    sid = request.sid
    if sid in clients:
        client_info = clients[sid]
        
        # Get new settings, keeping existing ones if not provided
        new_source_lang = data.get('sourceLanguage', client_info['source_lang'])
        new_target_lang = data.get('targetLanguage', client_info['target_lang'])
        new_tts_enabled = data.get('ttsEnabled', client_info['tts_enabled'])

        logging.info(f"Updating settings for sid {sid}: Source={new_source_lang}, Target={new_target_lang}, TTS={new_tts_enabled}")

        # --- Update client settings ---
        client_info['source_lang'] = new_source_lang
        client_info['target_lang'] = new_target_lang
        client_info['tts_enabled'] = new_tts_enabled
        
        # --- Recreate recognizer if language changes ---
        # This is a common pattern: stop the old, create a new one with new config.
        if client_info['speech_config'].speech_recognition_language != new_source_lang:
            logging.info(f"Source language changed for sid {sid}. Recreating recognizer with language: {new_source_lang}")
            
            try:
                # Stop the old recognizer
                if client_info.get('recognizer'):
                    client_info['recognizer'].stop_continuous_recognition()
                
                # Create new speech config and recognizer
                new_speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
                new_speech_config.speech_recognition_language = new_source_lang
                
                # Use the stored audio_config (e.g., push stream)
                new_recognizer = speechsdk.SpeechRecognizer(
                    speech_config=new_speech_config, 
                    audio_config=client_info['audio_config']
                )

                # Reconnect event handlers to the new recognizer
                new_recognizer.recognizing.connect(lambda evt: (
                    socketio.emit('interim_result', {'text': evt.result.text}, room=sid),
                    logging.debug(f"Recognizing for {sid}: {evt.result.text}")
                ))
                new_recognizer.recognized.connect(lambda evt: handle_final_recognition(evt, sid))
                new_recognizer.session_stopped.connect(lambda evt: logging.info(f"Session stopped for sid {sid}."))
                new_recognizer.canceled.connect(lambda evt: logging.info(f"Canceled event for sid {sid}."))
                
                # Start the new recognizer
                new_recognizer.start_continuous_recognition()
                
                # Update client info with the new recognizer and config
                client_info['recognizer'] = new_recognizer
                client_info['speech_config'] = new_speech_config
                
                logging.info(f"Recognizer reinitialized for sid {sid} with language: {new_source_lang}")

            except Exception as e:
                logging.error(f"Failed to reinitialize recognizer for sid {sid}: {e}")
                socketio.emit('server_error', {"error": "Failed to update speech settings. Please try again."})
                # Optionally, stop the current session if update fails critically
                cleanup_client(sid)
        
    else:
        logging.warning(f"Received settings_changed for unknown sid: {sid}")


@socketio.on('audio_data')
def handle_audio_data(data):
    """Handles incoming audio data chunks from a client and writes to the push stream."""
    sid = request.sid
    if sid in clients:
        try:
            # Write the received audio chunk to the push stream
            clients[sid]['stream'].write(data)
        except Exception as e:
            logging.error(f"Error writing to speech stream for sid {sid}: {e}")
            # If stream write fails, it often means the session is dead. Clean up.
            cleanup_client(sid)
            socketio.emit('server_error', {"error": "Audio stream error. Please restart recording."}, room=sid)
    else:
        logging.warning(f"Received audio_data for unknown sid: {sid}")


@socketio.on('disconnect')
def handle_disconnect():
    """Handles a client disconnection."""
    sid = request.sid
    logging.info(f"Client disconnected: {sid}")
    cleanup_client(sid) # Ensure resources are released

def cleanup_client(sid):
    """Stops the recognizer and cleans up resources for a specific client session."""
    if sid in clients:
        client_info = clients.pop(sid) # Remove from active clients
        
        # Stop the recognizer if it's running
        if client_info.get('recognizer'):
            try:
                client_info['recognizer'].stop_continuous_recognition()
                logging.info(f"Stopped recognizer for sid {sid}.")
            except Exception as e:
                logging.error(f"Error stopping recognizer for sid {sid}: {e}")
        
        # Close the push stream
        if client_info.get('stream'):
            try:
                client_info['stream'].close()
                logging.info(f"Closed push stream for sid {sid}.")
            except Exception as e:
                logging.error(f"Error closing stream for sid {sid}: {e}")
        
        logging.info(f"Cleaned up resources for sid {sid}")

@socketio.on('stop_translation')
def handle_stop_translation():
    """Handles client-initiated request to stop translation."""
    sid = request.sid
    logging.info(f"Client {sid} requested to stop translation.")
    cleanup_client(sid)

# --- Main Execution ---
if __name__ == '__main__':
    logging.info("Starting Flask-SocketIO application.")
    
    # Basic checks for essential configurations
    if not gemini_api_key:
        logging.error("GEMINI_API_KEY is missing. Gemini translation will not work.")
    if not speech_key or not speech_region:
        logging.error("Azure Speech SDK credentials are missing. Speech recognition/synthesis will not work.")
    
    port = int(os.environ.get('PORT', 5002)) # Default to 5002, or use PORT env var
    
    # Run the Flask-SocketIO app
    # In production, use a production-grade WSGI server (e.g., Gunicorn with eventlet/gevent workers)
    # allow_unsafe_werkzeug=True is for development only.
    socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True)