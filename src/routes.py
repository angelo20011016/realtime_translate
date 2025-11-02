from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from summary import get_summary_from_text

main_bp = Blueprint('main', __name__)

def init_routes(app):
    @main_bp.route('/')
    def index():
        user = session.get('user')
        if user:
            return render_template('mode_selection.html', user=user)
        return redirect(url_for('auth.login'))

    @main_bp.route('/login_page')
    def login_page():
        return render_template('login.html')

    @main_bp.route('/solo')
    def solo_mode():
        """Serves the solo mode HTML page."""
        if 'user' not in session:
            return redirect(url_for('auth.login_page'))
        return render_template('solo.html')

    @main_bp.route('/system')
    def system_mode():
        """Serves the system audio capture mode HTML page."""
        if 'user' not in session:
            return redirect(url_for('auth.login_page'))
        return render_template('system_audio.html')

    @main_bp.route('/chat')
    def chat_mode():
        """Serves the chat mode HTML page."""
        if 'user' not in session:
            return redirect(url_for('auth.login_page'))
        return render_template('chat.html')

    @main_bp.route('/conversation')
    def conversation_mode():
        """Serves the conversation mode HTML page."""
        if 'user' not in session:
            return redirect(url_for('auth.login'))
        return render_template('conversation.html')

    @main_bp.route('/summarize_transcript', methods=['POST'])
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

    app.register_blueprint(main_bp)
