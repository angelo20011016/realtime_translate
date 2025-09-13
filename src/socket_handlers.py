'''
This module contains all SocketIO event handlers.
'''
import logging
from flask import request
from flask_socketio import emit, join_room, leave_room
import azure.cognitiveservices.speech as speechsdk

# Import from our new modules
from src.speech_service import synthesize_speech
from src.translation_service import get_translation_prompt, get_batch_prompt
from src.client_manager import clients, rooms, sid_to_room, cleanup_client, cleanup_chat_client_recognizer
from summary import get_summary_from_text
from interview_coach import get_interview_feedback

def register_handlers(socketio, model, speech_key, speech_region, speech_config, LANGUAGE_VOICES, LANGUAGE_NAMES):

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

        if sid in sid_to_room:
            old_room_id = sid_to_room[sid]
            if sid in rooms.get(old_room_id, {}):
                del rooms[old_room_id][sid]
                if not rooms[old_room_id]:
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
            'recognizer': None,
            'stream': None
        }
        logging.info(f"Client {user_id} (sid: {sid}) joined room {room_id} with language {language}.")

        emit('room_update', {'users': [{'userId': member['userId']} for member in rooms[room_id].values()]}, room=room_id)
        emit('status_update', {'message': f'Joined room {room_id}. Start speaking!'}, room=sid)

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
                'language': language,
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

    def handle_final_recognition(evt, sid):
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
            prompt = get_translation_prompt(text, target_lang, LANGUAGE_NAMES)
            response = model.generate_content(prompt)
            refined_text = response.text.strip()
            logging.info(f"Translated text for sid {sid}: '{refined_text}'")
            
            socketio.emit('final_result', {
                "original": text,
                "refined": refined_text
            }, room=sid)

            if tts_enabled:
                synthesize_speech(refined_text, target_lang, sid, socketio, speech_config, LANGUAGE_VOICES)

        except Exception as e:
            logging.error(f"Gemini API error for sid {sid}: {e}")
            socketio.emit('server_error', {"error": "Translation failed due to Gemini API error."})

    def handle_chat_final_recognition(evt, sid, room_id, sender_user_id):
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

        for recipient_sid, recipient_info in list(rooms.get(room_id, {}).items()):
            recipient_lang = recipient_info['language']
            recipient_tts_enabled = recipient_info['tts_enabled']

            translated_text = text

            if recipient_lang != rooms[room_id][sid]['language']:
                try:
                    prompt = get_translation_prompt(text, recipient_lang, LANGUAGE_NAMES)
                    response = model.generate_content(prompt)
                    translated_text = response.text.strip()
                    logging.info(f"Translated for {recipient_info['userId']} (sid: {recipient_sid}): '{translated_text}'")
                except Exception as e:
                    logging.error(f"Gemini API error translating for {recipient_info['userId']} (sid: {recipient_sid}): {e}")
                    translated_text = f"Translation error: {text}"

            audio_data = None
            if recipient_tts_enabled:
                try:
                    # Call the modified synthesize_speech and get the audio data back
                    audio_data = synthesize_speech(translated_text, recipient_lang, recipient_sid, socketio, speech_config, LANGUAGE_VOICES, event_name='chat_audio_result')
                except Exception as e:
                    logging.error(f"Error during TTS for {recipient_info['userId']} (sid: {recipient_sid}): {e}")

            # Emit a single message containing text and audio data
            socketio.emit('chat_message', {
                "senderId": sender_user_id,
                "original": text,
                "translated": translated_text,
                "audio": audio_data  # This will now contain the audio data if TTS was successful
            }, room=recipient_sid)

    @socketio.on('connect')
    def handle_connect():
        logging.info(f"Client connected: {request.sid}")

    @socketio.on('start_translation')
    def handle_start_translation(data):
        sid = request.sid
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
        sid = request.sid
        logging.info(f"Settings changed for sid {sid}. Restarting translation process.")
        
        if sid in clients:
            cleanup_client(sid)

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
        sid = request.sid
        
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
        if sid in clients and clients[sid].get('recognizer') == recognizer_to_clean:
            clients.pop(sid, None)
            logging.info(f"Popped client {sid} because its recognizer session stopped.")
        else:
            logging.info(f"Not popping client {sid}; its recognizer may have already been replaced.")

    @socketio.on('disconnect')
    def handle_disconnect():
        sid = request.sid
        logging.info(f"Client disconnected: {sid}")
        
        if sid in sid_to_room:
            room_id = sid_to_room.pop(sid)
            if room_id in rooms and sid in rooms[room_id]:
                user_id = rooms[room_id][sid].get('userId', 'Unknown')
                cleanup_chat_client_recognizer(sid, room_id)
                del rooms[room_id][sid]
                if not rooms[room_id]:
                    del rooms[room_id]
                    logging.info(f"Room {room_id} is now empty and deleted.")
                else:
                    emit('room_update', {'users': [{'userId': member['userId']} for member in rooms[room_id].values()]}, room=room_id)
                logging.info(f"Cleaned up disconnected chat client {user_id} (sid: {sid}).")

        elif sid in clients:
            client_info = clients.pop(sid, None)
            if client_info and client_info.get('recognizer'):
                recognizer = client_info['recognizer']
                recognizer.recognized.disconnect_all()
                recognizer.session_stopped.disconnect_all()
                recognizer.canceled.disconnect_all()
                recognizer.recognizing.disconnect_all()
                recognizer.stop_continuous_recognition()
            if client_info and client_info.get('stream'):
                client_info['stream'].close()
            logging.info(f"Hard-cleaned and popped disconnected solo client {sid}")

    @socketio.on('process_batch')
    def handle_process_batch(data):
        sid = request.sid
        transcript = data.get('transcript')
        mode = data.get('mode')
        source_language = data.get('sourceLanguage')

        if not transcript or not mode or not source_language:
            socketio.emit('server_error', {"error": "Incomplete data received for batch processing."}, room=sid)
            return

        logging.info(f"Processing batch request for sid {sid}: Mode={mode}")

        try:
            prompt = get_batch_prompt(transcript, mode, source_language, LANGUAGE_NAMES)
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
        sid = request.sid
        text = data.get('text')
        if not text:
            return

        client_info = clients.get(sid)
        if not client_info:
            logging.warning(f"Could not find client info for sid {sid} to synthesize report.")
            return
        
        lang_code = client_info.get('source_lang')
        logging.info(f"Synthesizing report for sid {sid} in language {lang_code}")
        synthesize_speech(text, lang_code, sid, socketio, speech_config, LANGUAGE_VOICES, event_name='report_audio')

    @socketio.on('stop_translation')
    def handle_stop_translation():
        sid = request.sid
        logging.info(f"Client {sid} requested to stop translation.")
        
        if sid in sid_to_room:
            room_id = sid_to_room[sid]
            cleanup_chat_client_recognizer(sid, room_id)
        elif sid in clients:
            cleanup_client(sid)

    @socketio.on('get_ai_suggestion')
    def handle_get_ai_suggestion(data):
        sid = request.sid
        transcript = data.get('transcript')
        language = data.get('sourceLanguage')

        if not transcript or not language:
            socketio.emit('server_error', {"error": "Incomplete data for AI suggestion."}, room=sid)
            return

        logging.info(f"Generating AI suggestion for sid {sid}.")
        feedback = get_interview_feedback(transcript, language)
        
        socketio.emit('ai_suggestion_result', {
            "report": feedback
        }, room=sid)
