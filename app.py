import os
import logging
from src.main import app, socketio

if __name__ == '__main__':
    logging.info("Starting Flask-SocketIO server.")
    # Use the port from environment variables, with a default
    port = int(os.environ.get('PORT', 5002))
    # Use allow_unsafe_werkzeug=True for development with auto-reloading
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
