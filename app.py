import os
import json
import logging
import time
from dotenv import load_dotenv
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import google.generativeai as genai
import azure.cognitiveservices.speech as speechsdk

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'a-very-secret-key')
socketio = SocketIO(app)

# --- Gemini API Configuration ---
try:
    gemini_api_key = os.environ["GEMINI_API_KEY"]
    genai.configure(api_key=gemini_api_key)
    model = genai.GenerativeModel(model_name="gemini-2.5-flash-lite")
except KeyError:
    raise RuntimeError("GEMINI_API_KEY not found in .env file. Please add it.")

# --- Azure Speech SDK Configuration ---
try:
    speech_key = os.environ["AZURE_SPEECH_KEY"]
    speech_region = os.environ["AZURE_SPEECH_REGION"]
except KeyError:
    raise RuntimeError("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not found in .env file. Please add them.")

speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)

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

# Dictionary to hold recognizer and settings for each client
clients = {}

def get_translation_prompt(text, target_lang_code):
    """Generates a prompt for the Gemini model."""
    target_language_name = LANGUAGE_NAMES.get(target_lang_code, "the target language")
    return (
        f"You are an expert in oral translation. Your task is to translate the user's input into natural, "
        f"colloquial {target_language_name}. The user's input might be fragmented or ungrammatical because it's from real-time speech. "
        f"Refine it and provide a fluent translation. "
        f"Input: '{text}'\n"
        f"Please return only the translated sentence, without any explanation or extra text."
    )

def synthesize_speech(text, lang_code, sid):
    """Synthesizes text to speech and sends it to the client."""
    try:
        voice_name = LANGUAGE_VOICES.get(lang_code)
        if not voice_name:
            logging.warning(f"No voice configured for language {lang_code} for sid {sid}")
            return

        speech_config.speech_synthesis_voice_name = voice_name
        # Use a memory stream to hold the synthesized audio
        result = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None).speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logging.info(f"Speech synthesis successful for sid {sid}.")
            # Emit the audio data directly to the client
            socketio.emit('audio_synthesis_result', {'audio': result.audio_data}, room=sid)
        else:
            cancellation = result.cancellation_details
            logging.error(f"Speech synthesis canceled for sid {sid}: {cancellation.reason}")
            if cancellation.reason == speechsdk.CancellationReason.Error:
                logging.error(f"Error details: {cancellation.error_details}")

    except Exception as e:
        logging.error(f"Error during speech synthesis for sid {sid}: {e}")


def handle_final_recognition(evt, sid):
    """Handles final recognition results, translates, and optionally synthesizes speech."""
    text = evt.result.text
    
    if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
        if not text:
            return
    elif evt.result.reason == speechsdk.ResultReason.NoMatch:
        logging.info(f"No speech could be recognized for sid {sid}.")
        return
    elif evt.result.reason == speechsdk.ResultReason.Canceled:
        cancellation_details = evt.result.cancellation_details
        logging.error(f"Recognition canceled for sid {sid}: Reason={cancellation_details.reason}")
        if cancellation_details.reason == speechsdk.CancellationReason.Error:
            error_details = cancellation_details.error_details
            logging.error(f"Error details for sid {sid}: {error_details}")
            error_message = "Speech recognition failed."
            if "authentication" in error_details.lower() or "subscription" in error_details.lower():
                error_message = "Azure authentication failed. Check API key or subscription status."
            elif "websocket" in error_details.lower() or "connection" in error_details.lower():
                error_message = "Network connection issue with Azure service."
            socketio.emit('server_error', {"error": error_message}, room=sid)
        return

    client_info = clients.get(sid)
    if not client_info:
        logging.warning(f"Could not find client info for sid {sid}")
        return

    target_lang = client_info['target_lang']
    tts_enabled = client_info['tts_enabled']

    try:
        prompt = get_translation_prompt(text, target_lang)
        response = model.generate_content(prompt)
        refined_text = response.text.strip()
        logging.info(f"Translated text for sid {sid}: '{refined_text}'")
        
        socketio.emit('final_result', {
            "original": text,
            "refined": refined_text
        }, room=sid)

        if tts_enabled:
            synthesize_speech(refined_text, target_lang, sid)

    except Exception as e:
        logging.error(f"Gemini API error for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "Translation failed due to Gemini API error."})



@app.route('/')
def index():
    """Serves the main HTML page."""
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    """Handles a new client connection."""
    logging.info(f"Client connected: {request.sid}")

@socketio.on('start_translation')
def handle_start_translation(data):
    """Starts the speech recognition and translation process for a client."""
    sid = request.sid
    # Clean up any existing recognizer for this session before starting a new one
    if sid in clients:
        logging.warning(f"Found existing client session for {sid}. Cleaning up before starting new one.")
        cleanup_client(sid)

    source_lang = data.get('sourceLanguage', 'en-US')
    target_lang = data.get('targetLanguage', 'zh-TW')
    tts_enabled = data.get('ttsEnabled', False)

    logging.info(f"Starting translation for sid {sid}: Source={source_lang}, Target={target_lang}, TTS={tts_enabled}")

    try:
        client_speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
        client_speech_config.speech_recognition_language = source_lang
        
        push_stream = speechsdk.audio.PushAudioInputStream()
        audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
        speech_recognizer = speechsdk.SpeechRecognizer(speech_config=client_speech_config, audio_config=audio_config)

        clients[sid] = {
            'recognizer': speech_recognizer,
            'stream': push_stream,
            'source_lang': source_lang,
            'target_lang': target_lang,
            'tts_enabled': tts_enabled
        }

        speech_recognizer.recognizing.connect(lambda evt: socketio.emit('interim_result', {'text': evt.result.text}, room=sid))
        speech_recognizer.recognized.connect(lambda evt: handle_final_recognition(evt, sid))
        speech_recognizer.session_stopped.connect(lambda evt: logging.info(f"Session stopped for sid {sid}."))
        speech_recognizer.canceled.connect(lambda evt: logging.info(f"Canceled event for sid {sid}."))
        
        speech_recognizer.start_continuous_recognition()
    except Exception as e:
        logging.error(f"Failed to start recognizer for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "Failed to initialize speech recognizer."})


@socketio.on('settings_changed')
def handle_settings_changed(data):
    """Handles changes in language or TTS settings from the client."""
    sid = request.sid
    if sid in clients:
        client_info = clients[sid]
        
        # Get new settings, keeping existing ones if not provided
        source_lang = data.get('sourceLanguage', client_info['source_lang'])
        target_lang = data.get('targetLanguage', client_info['target_lang'])
        tts_enabled = data.get('ttsEnabled', client_info['tts_enabled'])

        # Log the change
        logging.info(f"Updating settings for sid {sid}: Source={source_lang}, Target={target_lang}, TTS={tts_enabled}")

        # Update the client's settings
        client_info['source_lang'] = source_lang
        client_info['target_lang'] = target_lang
        client_info['tts_enabled'] = tts_enabled
        
        # Update the speech recognizer's language
        if client_info['speech_config'].speech_recognition_language != source_lang:
            logging.info(f"Language changed for sid {sid}. Recreating recognizer.")
            
            # Stop the old recognizer
            client_info['recognizer'].stop_continuous_recognition()

            # Create a new recognizer with the updated language
            new_speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
            new_speech_config.speech_recognition_language = source_lang
            
            new_recognizer = speechsdk.SpeechRecognizer(
                speech_config=new_speech_config, 
                audio_config=client_info['audio_config']
            )

            # Connect new callbacks
            new_recognizer.recognizing.connect(lambda evt: (
                socketio.emit('interim_result', {'text': evt.result.text}, room=sid),
                logging.info(f"Recognizing event for sid {sid}: {evt.result.text}")
            ))
            new_recognizer.recognized.connect(lambda evt: handle_final_recognition(evt, sid))
            
            # Start the new recognizer
            new_recognizer.start_continuous_recognition()
            
            # Update client info with the new recognizer and config
            client_info['recognizer'] = new_recognizer
            client_info['speech_config'] = new_speech_config
        
    else:
        logging.warning(f"Received settings_changed for unknown sid: {sid}")


@socketio.on('audio_data')
def handle_audio_data(data):
    """Handles incoming audio data from a client."""
    sid = request.sid
    if sid in clients:
        try:
            clients[sid]['stream'].write(data)
        except Exception as e:
            logging.error(f"Error writing to speech stream for sid {sid}: {e}")
            cleanup_client(sid)
            socketio.emit('server_error', {"error": "Audio stream failed. Please restart recording."})

@socketio.on('disconnect')
def handle_disconnect():
    """Handles a client disconnection."""
    sid = request.sid
    logging.info(f"Client disconnected: {sid}")
    cleanup_client(sid)

def cleanup_client(sid):
    """Stops recognizer and cleans up resources for a client."""
    if sid in clients:
        client_info = clients.pop(sid)
        if client_info.get('recognizer'):
            client_info['recognizer'].stop_continuous_recognition()
        if client_info.get('stream'):
            client_info['stream'].close()
        logging.info(f"Cleaned up resources for sid {sid}")

@socketio.on('stop_translation')
def handle_stop_translation():
    """Handles client-initiated stop."""
    sid = request.sid
    logging.info(f"Client {sid} requested to stop translation.")
    cleanup_client(sid)

if __name__ == '__main__':
    logging.info("Starting Flask-SocketIO server.")
    port = int(os.environ.get('PORT', 5002))
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
