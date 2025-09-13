'''
This module manages the state of clients and chat rooms.
'''
import logging

# Dictionary to hold recognizer and settings for each solo client
clients = {}

# Dictionary to hold information about active chat rooms
# Structure: {room_id: {sid: {userId, language, tts_enabled, recognizer, stream}}}
rooms = {}

# Dictionary to map a client's sid to their room_id
sid_to_room = {}

def cleanup_client(sid):
    """Stops a solo client's recognizer and stream gracefully."""
    if sid in clients:
        client_info = clients.get(sid)
        if client_info and client_info.get('recognizer'):
            logging.info(f"Gracefully stopping recognizer for solo client sid {sid}.")
            client_info['recognizer'].stop_continuous_recognition()
        if client_info and client_info.get('stream'):
            client_info['stream'].close()

def cleanup_chat_client_recognizer(sid, room_id):
    """Stops a chat client's recognizer and stream."""
    if room_id in rooms and sid in rooms.get(room_id, {}):
        client_info = rooms[room_id][sid]
        if client_info.get('recognizer'):
            client_info['recognizer'].stop_continuous_recognition()
            client_info['recognizer'] = None
        if client_info.get('stream'):
            client_info['stream'].close()
            client_info['stream'] = None
        logging.info(f"Cleaned up chat recognizer for sid {sid} in room {room_id}")
