from gevent import monkey
monkey.patch_all()
import os
import logging
from dotenv import load_dotenv

# Load environment variables at the very beginning
load_dotenv()

# Import from src modules
# Note: The order is important to avoid circular dependencies
from src.config import app, socketio, model, speech_config, speech_key, speech_region, LANGUAGE_VOICES, LANGUAGE_NAMES, oauth
from src.auth import init_auth
from src.routes import init_routes
from src.socket_handlers import register_handlers

# Initialize modules by registering blueprints and handlers
init_auth(app, oauth)
init_routes(app)
register_handlers(socketio, model, speech_key, speech_region, speech_config, LANGUAGE_VOICES, LANGUAGE_NAMES)
