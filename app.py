import os
import json
import logging
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
except KeyError:
    raise RuntimeError("GEMINI_API_KEY not found in .env file. Please add it.")

# As per user request, using 'gemini-2.5-flash-lite'.
# If this model name is invalid, the script will fail at runtime.
model = genai.GenerativeModel(model_name="gemini-2.5-flash-lite")

# --- Azure Speech SDK Configuration ---
try:
    speech_key = os.environ["AZURE_SPEECH_KEY"]
    speech_region = os.environ["AZURE_SPEECH_REGION"]
except KeyError:
    raise RuntimeError("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not found in .env file. Please add them.")

speech_config = speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)
speech_config.speech_recognition_language = "en-US"

# Dictionary to hold recognizer instances for each client
recognizers = {}

def handle_interim_recognition(text, sid):
    """Handles interim recognition results."""
    logging.info(f"Interim text for sid {sid}: '{text}'")
    socketio.emit('interim_result', {'text': text}, room=sid)

def translate_and_refine(text, sid):
    """Translates and refines text using Gemini and sends it to a specific client."""
    logging.info(f"Final recognized text for sid {sid}: '{text}'")
    try:
        prompt = f"You are an expert in oral translation, good at refining a user's unsmooth language and translating it into colloquial sentences. Input: '{text}' 請單純回傳翻譯過後的句子 不要解釋"
        response = model.generate_content(prompt)
        refined_text = response.text
        logging.info(f"Refined text for sid {sid}: '{refined_text}'")
        
        socketio.emit('final_result', {
            "original": text,
            "refined": refined_text
        }, room=sid)
    except Exception as e:
        logging.error(f"Gemini API error for sid {sid}: {e}")
        socketio.emit('translation_error', {"error": "Translation and refinement failed."}, room=sid)


@app.route('/')
def index():
    """Serves the main HTML page."""
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    """Handles a new client connection."""
    sid = request.sid
    logging.info(f"Client connected: {sid}")
    
    push_stream = speechsdk.audio.PushAudioInputStream()
    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
    speech_recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    speech_recognizer.recognizing.connect(lambda evt: handle_interim_recognition(evt.result.text, sid))
    speech_recognizer.recognized.connect(lambda evt: translate_and_refine(evt.result.text, sid))
    
    recognizers[sid] = (speech_recognizer, push_stream)
    
    speech_recognizer.start_continuous_recognition()

@socketio.on('audio_data')
def handle_audio_data(data):
    """Handles incoming audio data from a client."""
    sid = request.sid
    if sid in recognizers:
        _, push_stream = recognizers[sid]
        push_stream.write(data)

@socketio.on('disconnect')
def handle_disconnect():
    """Handles a client disconnection."""
    sid = request.sid
    logging.info(f"Client disconnected: {sid}")
    if sid in recognizers:
        speech_recognizer, push_stream = recognizers.pop(sid)
        push_stream.close()
        speech_recognizer.stop_continuous_recognition()

if __name__ == '__main__':
    logging.info("Starting Flask-SocketIO server with SSL.")
    # For development, run directly. For production, use a proper WSGI server like Gunicorn.
    socketio.run(app, host='0.0.0.0', port=443, allow_unsafe_werkzeug=True, certfile='/etc/letsencrypt/live/happywecan.com/fullchain.pem', keyfile='/etc/letsencrypt/live/happywecan.com/privkey.pem')