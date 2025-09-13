import logging
import azure.cognitiveservices.speech as speechsdk

def synthesize_speech(text, lang_code, sid, socketio, speech_config, LANGUAGE_VOICES, event_name='audio_synthesis_result'):
    """
    Synthesizes text to speech.
    If event_name is 'chat_audio_result', it returns the audio data.
    Otherwise, it sends the audio data to the client on the specified event.
    """
    try:
        voice_name = LANGUAGE_VOICES.get(lang_code)
        if not voice_name:
            logging.warning(f"No voice configured for language {lang_code} for sid {sid}")
            return None

        speech_config.speech_synthesis_voice_name = voice_name
        speech_config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3)
        
        result = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None).speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logging.info(f"Speech synthesis successful for sid {sid}.")
            audio_data = result.audio_data
            
            # For chat, return data to be sent in a single message.
            if event_name == 'chat_audio_result':
                return audio_data
            # For other modes, emit directly.
            else:
                socketio.emit(event_name, {'audio': audio_data}, room=sid)
                return None
        else:
            cancellation = result.cancellation_details
            logging.error(f"Speech synthesis canceled for sid {sid}: {cancellation.reason}")
            if cancellation.reason == speechsdk.CancellationReason.Error:
                logging.error(f"Error details: {cancellation.error_details}")
            return None

    except Exception as e:
        logging.error(f"Error during speech synthesis for sid {sid}: {e}")
        return None
