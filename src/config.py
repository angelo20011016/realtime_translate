import os
import logging
from dotenv import load_dotenv
from flask import Flask
from authlib.integrations.flask_client import OAuth
from flask_socketio import SocketIO
import google.generativeai as genai
import azure.cognitiveservices.speech as speechsdk

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv()

app = Flask(__name__, template_folder='../templates', static_folder='../static')
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'a-very-secret-key')
# Use REDIS_URL from environment if available, otherwise fall back to local redis
redis_url = os.getenv('REDIS_URL', 'redis://redis')
socketio = SocketIO(app, async_mode='gevent', message_queue=redis_url)

# --- OAuth Configuration ---
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    access_token_url='https://accounts.google.com/o/oauth2/token',
    access_token_params=None,
    authorize_url='https://accounts.google.com/o/oauth2/auth',
    authorize_params=None,
    api_base_url='https://www.googleapis.com/oauth2/v1/',
    userinfo_endpoint='https://openidconnect.googleapis.com/v1/userinfo',
    client_kwargs={'scope': 'openid email profile'},
    jwks_uri="https://www.googleapis.com/oauth2/v3/certs",
)

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
    "ja-JP": "ja-JP-NanamiNeural",
    "fr-FR": "fr-FR-DeniseNeural"
}
LANGUAGE_NAMES = {
    "en-US": "English",
    "zh-TW": "Traditional Chinese",
    "ja-JP": "Japanese",
    "fr-FR": "French"
}
