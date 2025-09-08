
from gevent import monkey
monkey.patch_all()
import redis
import os
import json
import logging
import time
from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify
from summary import get_summary_from_text
from flask_socketio import SocketIO, emit, join_room, leave_room
import google.generativeai as genai
import azure.cognitiveservices.speech as speechsdk

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'a-very-secret-key')
socketio = SocketIO(app, async_mode='gevent', message_queue='redis://redis')

# Add this block after socketio initialization
# try:
#     r = redis.Redis(host='redis', port=6379, db=0)
#     r.ping()
#     r.set('test_key', 'test_value')
#     test_value = r.get('test_key')
#     logging.info(f"Redis connection successful! test_key: {test_value.decode()}")
# except Exception as e:
#     logging.error(f"Redis connection failed: {e}")

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

# Dictionary to hold information about active rooms
# Structure: {room_id: {sid: {userId, language, tts_enabled, recognizer, stream}}}
rooms = {}

# Dictionary to map sid to room_id
sid_to_room = {}

@socketio.on('join_room')
def handle_join_room(data):
    sid = request.sid
    room_id = data.get('roomId')
    user_id = data.get('userId')
    language = data.get('language')
    tts_enabled = data.get('ttsEnabled', False)

    if not room_id or not user_id or not language:
        emit('server_error', {'error': 'Room ID, User ID, and Language are required to join a room.'}, room=sid)
        return

    # Leave any previously joined room
    if sid in sid_to_room:
        old_room_id = sid_to_room[sid]
        if sid in rooms.get(old_room_id, {}):
            del rooms[old_room_id][sid]
            if not rooms[old_room_id]: # If room is empty, delete it
                del rooms[old_room_id]
        logging.info(f"Client {user_id} (sid: {sid}) left room {old_room_id}.")
        emit('room_update', {'users': [{'userId': member['userId']} for member in rooms.get(old_room_id, {}).values()]}, room=old_room_id)


    join_room(room_id)
    sid_to_room[sid] = room_id

    if room_id not in rooms:
        rooms[room_id] = {}

    rooms[room_id][sid] = {
        'userId': user_id,
        'language': language,
        'tts_enabled': tts_enabled,
        'recognizer': None, # Will be set when translation starts
        'stream': None      # Will be set when translation starts
    }
    logging.info(f"Client {user_id} (sid: {sid}) joined room {room_id} with language {language}.")

    # Broadcast updated user list to all in the room
    emit('room_update', {'users': [{'userId': member['userId']} for member in rooms[room_id].values()]}, room=room_id)
    emit('status_update', {'message': f'Joined room {room_id}. Start speaking!'}, room=sid)



# Chat mode: 更新用戶語言/tts 設定
@socketio.on('update_user_settings')
def handle_update_user_settings(data):
    sid = request.sid
    language = data.get('language')
    tts_enabled = data.get('ttsEnabled', False)
    room_id = sid_to_room.get(sid)
    user_id = None
    if room_id and room_id in rooms and sid in rooms[room_id]:
        user_id = rooms[room_id][sid].get('userId')
        rooms[room_id][sid]['language'] = language
        rooms[room_id][sid]['tts_enabled'] = tts_enabled
        logging.info(f"[Chat] User {user_id} in room {room_id} updated settings: language={language}, tts_enabled={tts_enabled}")
    else:
        logging.warning(f"[Chat] update_user_settings: sid {sid} not found in any room.")


@socketio.on('start_chat_translation')
def handle_start_chat_translation(data):
    sid = request.sid
    room_id = data.get('roomId')
    user_id = data.get('userId')
    language = data.get('language')
    tts_enabled = data.get('ttsEnabled', False)

    if sid not in rooms.get(room_id, {}):
        emit('server_error', {'error': 'Not in a valid room.'}, room=sid)
        return

    # Clean up any existing recognizer for this session before starting a new one
    if rooms[room_id][sid].get('recognizer'):
        logging.warning(f"Found existing recognizer for {user_id} (sid: {sid}). Cleaning up.")
        cleanup_chat_client_recognizer(sid, room_id)

    logging.info(f"Starting chat translation for {user_id} (sid: {sid}): Language={language}, TTS={tts_enabled}")

    try:
        client_speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
        client_speech_config.speech_recognition_language = language
        
        push_stream = speechsdk.audio.PushAudioInputStream()
        audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
        speech_recognizer = speechsdk.SpeechRecognizer(speech_config=client_speech_config, audio_config=audio_config)

        rooms[room_id][sid].update({
            'recognizer': speech_recognizer,
            'stream': push_stream,
            'language': language, # Update language in case it changed
            'tts_enabled': tts_enabled
        })

        speech_recognizer.recognizing.connect(lambda evt: socketio.emit('interim_result', {'text': evt.result.text}, room=sid))
        speech_recognizer.recognized.connect(lambda evt: handle_chat_final_recognition(evt, sid, room_id, user_id))
        speech_recognizer.session_stopped.connect(lambda evt: logging.info(f"Chat session stopped for {user_id} (sid: {sid})."))
        speech_recognizer.canceled.connect(lambda evt: logging.info(f"Chat canceled event for {user_id} (sid: {sid})."))
        
        speech_recognizer.start_continuous_recognition()
    except Exception as e:
        logging.error(f"Failed to start chat recognizer for {user_id} (sid: {sid}): {e}")
        emit('server_error', {'error': 'Failed to initialize speech recognizer for chat.'}, room=sid)

def cleanup_chat_client_recognizer(sid, room_id):
    if room_id in rooms and sid in rooms[room_id]:
        client_info = rooms[room_id][sid]
        if client_info.get('recognizer'):
            client_info['recognizer'].stop_continuous_recognition()
            client_info['recognizer'] = None
        if client_info.get('stream'):
            client_info['stream'].close()
            client_info['stream'] = None
        logging.info(f"Cleaned up chat recognizer for sid {sid} in room {room_id}")

# --- MODIFIED FUNCTION START ---
def get_translation_prompt(text, target_lang_code):
    """
    Generates a prompt for the Gemini model, prioritizing Traditional Chinese (Taiwan).
    Ensures natural, colloquial, and accurate translation, avoiding non-target dialects/scripts.
    """
    target_language_name = LANGUAGE_NAMES.get(target_lang_code, "the target language")
    
    # Explicitly define prompt for better control over translation output when target is Traditional Chinese
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
    else: # General prompt for other languages (English, Japanese, etc.)
        prompt = (
            f"You are an expert in oral translation. Your task is to translate the user's input into natural, "
            f"colloquial {target_language_name}. The user's input might be fragmented or ungrammatical because it's from real-time speech. "
            f"Refine it and provide a fluent translation. "
            f"Input: '{text}'\n"
            f"Please return only the translated sentence, without any explanation or extra text."
        )
    
    return prompt
# --- MODIFIED FUNCTION END ---


def synthesize_speech(text, lang_code, sid, event_name='audio_synthesis_result'):
    """Synthesizes text to speech and sends it to the client on a specified event."""
    try:
        voice_name = LANGUAGE_VOICES.get(lang_code)
        if not voice_name:
            logging.warning(f"No voice configured for language {lang_code} for sid {sid}")
            return

        speech_config.speech_synthesis_voice_name = voice_name
        speech_config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3)
        # Use a memory stream to hold the synthesized audio
        result = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None).speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logging.info(f"Speech synthesis successful for sid {sid}.")
            # Emit the audio data directly to the client on the specified event
            socketio.emit(event_name, {'audio': result.audio_data}, room=sid)
        else:
            cancellation = result.cancellation_details
            logging.error(f"Speech synthesis canceled for sid {sid}: {cancellation.reason}")
            if cancellation.reason == speechsdk.CancellationReason.Error:
                logging.error(f"Error details: {cancellation.error_details}")

    except Exception as e:
        logging.error(f"Error during speech synthesis for sid {sid}: {e}")


def handle_final_recognition(evt, sid):
    """Handles final recognition results, translates, and optionally synthesizes speech."""
    # Race condition check: client might have disconnected
    if sid not in clients:
        logging.warning(f"Received recognition result for an already disconnected client: {sid}")
        return

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

def handle_chat_final_recognition(evt, sid, room_id, sender_user_id):
    """Handles final recognition results for chat, translates, and broadcasts."""
    text = evt.result.text
    
    if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
        if not text:
            return
    elif evt.result.reason == speechsdk.ResultReason.NoMatch:
        logging.info(f"No speech could be recognized for {sender_user_id} (sid: {sid}) in room {room_id}.")
        return
    elif evt.result.reason == speechsdk.ResultReason.Canceled:
        cancellation_details = evt.result.cancellation_details
        logging.error(f"Chat recognition canceled for {sender_user_id} (sid: {sid}): Reason={cancellation_details.reason}")
        if cancellation_details.reason == speechsdk.CancellationReason.Error:
            error_details = cancellation_details.error_details
            logging.error(f"Error details for {sender_user_id} (sid: {sid}): {error_details}")
            emit('server_error', {"error": "Speech recognition failed in chat."}, room=sid)
        return

    logging.info(f"Recognized speech from {sender_user_id} (sid: {sid}) in room {room_id}: '{text}'")

    if room_id not in rooms:
        logging.warning(f"Room {room_id} not found for sid {sid}.")
        return

    # Iterate through all members in the room
    for recipient_sid, recipient_info in rooms[room_id].items():
        recipient_lang = recipient_info['language']
        recipient_tts_enabled = recipient_info['tts_enabled']

        translated_text = text # Default to original if no translation needed or fails

        # Translate for other users or if the sender's language is different from recipient's
        if recipient_lang != rooms[room_id][sid]['language']:
            try:
                prompt = get_translation_prompt(text, recipient_lang)
                response = model.generate_content(prompt)
                translated_text = response.text.strip()
                logging.info(f"Translated for {recipient_info['userId']} (sid: {recipient_sid}): '{translated_text}'")
            except Exception as e:
                logging.error(f"Gemini API error translating for {recipient_info['userId']} (sid: {recipient_sid}): {e}")
                translated_text = f"Translation error: {text}" # Fallback to original or error message

        audio_data = None
        if recipient_tts_enabled:
            try:
                voice_name = LANGUAGE_VOICES.get(recipient_lang)
                if voice_name:
                    speech_config.speech_synthesis_voice_name = voice_name
                    result = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None).speak_text_async(translated_text).get()
                    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                        audio_data = result.audio_data
                    else:
                        logging.error(f"TTS failed for {recipient_info['userId']} (sid: {recipient_sid}): {result.cancellation_details.reason}")
                else:
                    logging.warning(f"No voice configured for language {recipient_lang} for sid {recipient_sid}")
            except Exception as e:
                logging.error(f"Error during TTS for {recipient_info['userId']} (sid: {recipient_sid}): {e}")

        # Emit chat message to each recipient
        socketio.emit('chat_message', {
            "senderId": sender_user_id,
            "original": text,
            "translated": translated_text,
            "audio": audio_data if audio_data else None # Send raw bytes
        }, room=recipient_sid)


@app.route('/')
def index():
    """Serves the mode selection page."""
    return render_template('mode_selection.html')

@app.route('/solo')
def solo_mode():
    """Serves the solo mode HTML page."""
    return render_template('solo.html')

@app.route('/system')
def system_mode():
    """Serves the system audio capture mode HTML page."""
    return render_template('system_audio.html')

@app.route('/chat')
def chat_mode():
    """Serves the chat mode HTML page."""
    return render_template('chat.html')

@socketio.on('connect')
def handle_connect():
    """Handles a new client connection."""
    logging.info(f"Client connected: {request.sid}")
    # No specific action here for chat clients, as they will send a 'join_room' event
    # Solo clients will send 'start_translation'

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
        speech_recognizer.session_stopped.connect(lambda evt: _final_cleanup(sid, speech_recognizer))
        speech_recognizer.canceled.connect(lambda evt: logging.info(f"Canceled event for sid {sid}."))
        
        speech_recognizer.start_continuous_recognition()
    except Exception as e:
        logging.error(f"Failed to start recognizer for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "Failed to initialize speech recognizer."})


@socketio.on('settings_changed')
def handle_settings_changed(data):
    """Handles changes in language or TTS settings from the client by restarting the recognizer."""
    sid = request.sid
    logging.info(f"Settings changed for sid {sid}. Restarting translation process.")
    
    # First, stop and clean up any existing process for this client.
    if sid in clients:
        cleanup_client(sid)

    # Now, start a new translation process with the new settings.
    # This logic is duplicated from handle_start_translation for simplicity and safety.
    source_lang = data.get('sourceLanguage')
    target_lang = data.get('targetLanguage')
    tts_enabled = data.get('ttsEnabled', False)

    if not source_lang or not target_lang:
        logging.warning(f"Incomplete settings received for sid {sid}. Aborting settings change.")
        return

    logging.info(f"Applying new settings for sid {sid}: Source={source_lang}, Target={target_lang}, TTS={tts_enabled}")

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
        speech_recognizer.session_stopped.connect(lambda evt: _final_cleanup(sid, speech_recognizer))
        speech_recognizer.canceled.connect(lambda evt: logging.info(f"Canceled event for sid {sid}."))
        
        speech_recognizer.start_continuous_recognition()
    except Exception as e:
        logging.error(f"Failed to restart recognizer for sid {sid} after settings change: {e}")
        socketio.emit('server_error', {"error": "Failed to apply new settings."})


@socketio.on('audio_data')
def handle_audio_data(data):
    """Handles incoming audio data from a client."""
    sid = request.sid
    
    # Check if client is in a chat room
    if sid in sid_to_room:
        room_id = sid_to_room[sid]
        if room_id in rooms and sid in rooms[room_id] and rooms[room_id][sid].get('stream'):
            try:
                rooms[room_id][sid]['stream'].write(data)
            except Exception as e:
                logging.error(f"Error writing to chat speech stream for sid {sid} in room {room_id}: {e}")
                cleanup_chat_client_recognizer(sid, room_id)
                socketio.emit('server_error', {"error": "Audio stream failed. Please restart recording."}, room=sid)
        else:
            logging.warning(f"Audio data received for sid {sid} not in active chat stream.")
    # Else, it's a solo client
    elif sid in clients and clients[sid].get('stream'):
        try:
            clients[sid]['stream'].write(data)
        except Exception as e:
            logging.error(f"Error writing to solo speech stream for sid {sid}: {e}")
            cleanup_client(sid)
            socketio.emit('server_error', {"error": "Audio stream failed. Please restart recording."}, room=sid)
    else:
        logging.warning(f"Audio data received for unknown or inactive sid: {sid}")

def _final_cleanup(sid, recognizer_to_clean):
    """Safely removes a client's state, ensuring the recognizer matches."""
    # Check if the client still exists and if the recognizer is the one we expect to clean up.
    if sid in clients and clients[sid].get('recognizer') == recognizer_to_clean:
        clients.pop(sid, None)
        logging.info(f"Popped client {sid} because its recognizer session stopped.")
    else:
        # This is normal during a quick restart. The old session stopped, but a new one is already active.
        logging.info(f"Not popping client {sid}; its recognizer may have already been replaced.")

@socketio.on('disconnect')
def handle_disconnect():
    """Handles a client disconnection with immediate, hard cleanup."""
    sid = request.sid
    logging.info(f"Client disconnected: {sid}")
    
    # Chat room cleanup
    if sid in sid_to_room:
        room_id = sid_to_room.pop(sid)
        if room_id in rooms and sid in rooms[room_id]:
            user_id = rooms[room_id].get('userId', 'Unknown')
            cleanup_chat_client_recognizer(sid, room_id)
            del rooms[room_id][sid]
            if not rooms[room_id]:
                del rooms[room_id]
                logging.info(f"Room {room_id} is now empty and deleted.")
            else:
                emit('room_update', {'users': [{'userId': member['userId']} for member in rooms[room_id].values()]}, room=room_id)
            logging.info(f"Cleaned up disconnected chat client {user_id} (sid: {sid}).")

    # Solo client cleanup
    elif sid in clients:
        client_info = clients.pop(sid, None)
        if client_info and client_info.get('recognizer'):
            # Disconnect all handlers to prevent them from firing after the client is gone
            recognizer = client_info['recognizer']
            recognizer.recognized.disconnect_all()
            recognizer.session_stopped.disconnect_all()
            recognizer.canceled.disconnect_all()
            recognizer.recognizing.disconnect_all()
            recognizer.stop_continuous_recognition()
        if client_info and client_info.get('stream'):
            client_info['stream'].close()
        logging.info(f"Hard-cleaned and popped disconnected solo client {sid}")

def cleanup_client(sid):
    """Stops a client's recognizer gracefully, allowing final events to be processed."""
    if sid in clients:
        client_info = clients[sid]
        if client_info.get('recognizer'):
            logging.info(f"Gracefully stopping recognizer for sid {sid}.")
            client_info['recognizer'].stop_continuous_recognition()
        if client_info.get('stream'):
            client_info['stream'].close()

def get_batch_prompt(transcript, mode, source_language):
    """Generates a prompt for batch processing based on the selected mode."""
    source_lang_name = LANGUAGE_NAMES.get(source_language, source_language)

    if mode == 'summarize':
        prompt = (
            f"You are a professional meeting assistant. The following is a transcript of a meeting in {source_lang_name}. "
            f"Please provide a concise summary of the meeting. Identify key decisions made and action items for participants."
            f"\n\nTranscript:\n\n{transcript}"
            f"\n\nSummary:"
        )
    elif mode == 'interview':
        prompt = (
            f"You are an expert interview coach. The following is a transcript of a job interview. The candidate's responses are in {source_lang_name}. "
            f"Please analyze the candidate's responses. Provide constructive feedback on their communication skills, the clarity of their answers, and the overall impression they made. "
            f"Suggest specific areas for improvement. Structure your feedback into sections: Strengths, Areas for Improvement, and Key Takeaways."
            f"\n\nInterview Transcript:\n\n{transcript}"
            f"\n\nFeedback:"
        )
    else:
        prompt = f"Please process the following text: {transcript}"
    
    return prompt

@socketio.on('process_batch')
def handle_process_batch(data):
    """Handles a batch processing request from the client."""
    sid = request.sid
    transcript = data.get('transcript')
    mode = data.get('mode')
    source_language = data.get('sourceLanguage')

    if not transcript or not mode or not source_language:
        socketio.emit('server_error', {"error": "Incomplete data received for batch processing."}, room=sid)
        return

    logging.info(f"Processing batch request for sid {sid}: Mode={mode}")

    try:
        prompt = get_batch_prompt(transcript, mode, source_language)
        response = model.generate_content(prompt)
        report_text = response.text.strip()
        logging.info(f"Generated report for sid {sid}")
        
        socketio.emit('batch_result', {
            "report": report_text
        }, room=sid)

    except Exception as e:
        logging.error(f"Gemini API error during batch processing for sid {sid}: {e}")
        socketio.emit('server_error', {"error": "Failed to generate report due to an API error."})


@socketio.on('request_report_audio')
def handle_request_report_audio(data):
    """Handles a client request to synthesize the generated report text."""
    sid = request.sid
    text = data.get('text')
    if not text:
        return

    client_info = clients.get(sid)
    if not client_info:
        logging.warning(f"Could not find client info for sid {sid} to synthesize report.")
        return
    
    # Use the original source language for the report synthesis
    lang_code = client_info.get('source_lang')
    logging.info(f"Synthesizing report for sid {sid} in language {lang_code}")
    synthesize_speech(text, lang_code, sid, event_name='report_audio')



@socketio.on('stop_translation')
def handle_stop_translation():
    """Handles client-initiated stop."""

    sid = request.sid
    logging.info(f"Client {sid} requested to stop translation.")
    
    if sid in sid_to_room: # It's a chat client
        room_id = sid_to_room[sid]
        cleanup_chat_client_recognizer(sid, room_id)
    elif sid in clients: # It's a solo client
        cleanup_client(sid)

@app.route('/summarize_transcript', methods=['POST'])
def summarize_transcript():
    """Receives transcript text and returns a summary."""
    data = request.get_json()
    text = data.get('text')
    language = data.get('language')

    if not text or not language:
        return jsonify({'error': 'Missing text or language in request.'}), 400

    summary = get_summary_from_text(text, language)

    if "Error:" in summary:
        return jsonify({'error': summary}), 500

    return jsonify({'summary': summary})

if __name__ == '__main__':
    logging.info("Starting Flask-SocketIO server.")
    port = int(os.environ.get('PORT', 5002))
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)