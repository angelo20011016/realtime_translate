import os
from flask import session, redirect, url_for, Blueprint

auth_bp = Blueprint('auth', __name__)

def init_auth(app, oauth):
    # OAuth configuration is already in config.py, we just need to register the routes

    @auth_bp.route('/login')
    def login():
        is_dev_mode = os.getenv('DEV_MODE') == 'true'
        
        if is_dev_mode:
            # In development mode, use the local redirect_uri
            redirect_uri = 'http://localhost:5002/authorize'
        else:
            # In production mode, read the production redirect_uri from environment variables
            redirect_uri = os.getenv('PROD_REDIRECT_URI', 'https://happywecan.com/authorize')
                
        return oauth.google.authorize_redirect(redirect_uri)

    @auth_bp.route('/authorize')
    def authorize():
        token = oauth.google.authorize_access_token()
        user_info = oauth.google.get('userinfo').json()
        session['user'] = user_info
        return redirect('/')

    @auth_bp.route('/logout')
    def logout():
        session.pop('user', None)
        return redirect('/')
    
    app.register_blueprint(auth_bp)
