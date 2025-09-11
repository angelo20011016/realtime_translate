# Google SSO 整合教學

本文件詳細記錄了將 Google SSO (單一登入) 整合到一個基於 Flask 和 Docker 的 Python 應用程式中的完整步驟。

## 專案背景

此專案是一個即時翻譯應用程式，使用 Flask-SocketIO 進行即時通訊，並透過 Docker 進行容器化部署。

## 整合目標

在應用程式中加入 Google 帳號登入功能，取代原有的匿名存取，以便更好地管理使用者。

---

## 步驟一：安裝必要的 Python 套件

我們需要 `Authlib` 這個強大的函式庫來處理 OAuth 2.0 的認證流程。

在您的 `requirements.txt` 檔案中加入 `Authlib`，然後執行以下指令進行安裝：

```bash
pip install Authlib
```

## 步驟二：設定 Google API Console

這是整個流程中最關鍵的一步，任何設定錯誤都可能導致登入失敗。

1.  **前往 Google API Console:** [https://console.developers.google.com/](https://console.developers.google.com/)
2.  **建立新專案** 或選取一個現有的專案。
3.  在左側導覽列中，前往 **「憑證」** 頁面。
4.  點擊 **「+ 建立憑證」**，然後選擇 **「OAuth 用戶端 ID」**。
5.  在「應用程式類型」中，選擇 **「網頁應用程式」**。
6.  **設定已授權的重新導向 URI:** 這是 Google 在使用者成功登入後，要將使用者導回的您應用程式的網址。您需要加入以下兩個 URI：
    *   **本地開發用:** `http://localhost:5002/authorize`
    *   **正式環境用 (如果您的網域是 happywecan.com):** `https://happywecan.com/authorize`

7.  點擊「建立」，您將會得到一組 **用戶端 ID** 和 **用戶端密碼**。請妥善保管它們。

## 步驟三：設定環境變數

在您的專案根目錄下，找到或建立一個名為 `.env` 的檔案，並將您從 Google API Console 取得的金鑰填入其中：

```
GOOGLE_CLIENT_ID="YOUR_GOOGLE_CLIENT_ID"
GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET"
SECRET_KEY="A_VERY_SECRET_RANDOM_KEY_FOR_FLASK_SESSION"
```

`SECRET_KEY` 是 Flask 用來加密 session 的金鑰，請務必設定一個複雜且隨機的字串。

## 步驟四：修改 Flask 應用程式 (`app.py`)

這是核心的程式碼修改，我們將加入所有 SSO 相關的邏輯。

```python
from gevent import monkey
monkey.patch_all()
import redis
import os
import json
import logging
import time
from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from authlib.integrations.flask_client import OAuth
from summary import get_summary_from_text
from interview_coach import get_interview_feedback
from flask_socketio import SocketIO, emit, join_room, leave_room
import google.generativeai as genai
import azure.cognitiveservices.speech as speechsdk

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'a-very-secret-key')
redis_url = os.getenv('REDIS_URL', 'redis://redis')
socketio = SocketIO(app, async_mode='gevent', message_queue=redis_url)

# --- OAuth Configuration ---
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1' # 允許在本地開發時使用 HTTP
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
    jwks_uri="https://www.googleapis.com/oauth2/v3/certs", # 直接提供金鑰 URI
)

# ... (您其他的程式碼保持不變) ...

# --- 新增的路由 ---

@app.route('/')
def index():
    user = session.get('user')
    if user:
        return render_template('mode_selection.html', user=user)
    return redirect(url_for('login_page'))

@app.route('/login_page')
def login_page():
    return render_template('login.html')

@app.route('/login')
def login():
    # 在 Docker 環境中，我們手動指定 redirect_uri 以確保網址正確
    redirect_uri = 'http://happywecan.com/authorize'
    return google.authorize_redirect(redirect_uri)

@app.route('/authorize')
def authorize():
    try:
        token = google.authorize_access_token()
        user_info = google.get('userinfo').json()
        session['user'] = user_info
        return redirect('/')
    except Exception as e:
        logging.error(f"Error in authorize route: {e}")
        return "Internal Server Error", 500

@app.route('/logout')
def logout():
    session.pop('user', None)
    return redirect('/')

# --- 保護現有的路由 ---

@app.route('/solo')
def solo_mode():
    if 'user' not in session:
        return redirect('/')
    return render_template('solo.html')

@app.route('/system')
def system_mode():
    if 'user' not in session:
        return redirect('/')
    return render_template('system_audio.html')

@app.route('/chat')
def chat_mode():
    if 'user' not in session:
        return redirect('/')
    return render_template('chat.html')

# ... (您其他的程式碼保持不變) ...

```

## 步驟五：建立登入頁面 (`templates/login.html`)

建立一個新的 HTML 檔案來作為使用者登入的入口。

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Orbitron:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        :root {
            --dark-bg: #181a2f;
            --primary-bg: #20243b;
            --accent-cyan: #4fd1c5;
            --text-light: #e2e8f0;
            --neon-text-shadow: 0 0 8px rgba(79, 209, 197, 0.5);
        }
        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--dark-bg);
            color: var(--text-light);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
        }
        .login-container {
            background-color: var(--primary-bg);
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
            text-align: center;
        }
        h1 {
            font-family: 'Orbitron', sans-serif;
            color: var(--accent-cyan);
            text-shadow: var(--neon-text-shadow);
            margin-bottom: 30px;
        }
        .login-button {
            display: inline-block;
            padding: 15px 25px;
            font-size: 1.2rem;
            font-weight: 600;
            color: var(--text-light);
            background-color: var(--accent-cyan);
            border: none;
            border-radius: 8px;
            text-decoration: none;
            transition: all 0.3s ease;
        }
        .login-button:hover {
            filter: brightness(1.1);
            box-shadow: 0 0 15px rgba(79, 209, 197, 0.6);
        }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>Realtime Translate</h1>
        <a href="/login" class="login-button">Login with Google</a>
    </div>
</body>
</html>
```

## 步驟六：修改模式選擇頁面 (`templates/mode_selection.html`)

更新您現有的模式選擇頁面，以顯示登入後的使用者資訊和一個登出按鈕。

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <!-- ... (您的 head 內容保持不變) ... -->
    <style>
        /* ... (您原有的 style 內容保持不變) ... */
        .user-info {
            margin-bottom: 20px;
        }
        .logout-button {
            margin-top: 20px;
            background-color: #dc3545; /* 給登出按鈕一個不同的顏色 */
        }
    </style>
</head>
<body>
    <div class="mode-selection-container">
        <h1>Choose Your Mode</h1>
        {% if user %}
            <div class="user-info">
                <p>Welcome, {{ user.name }}!</p>
                <p>({{ user.email }})</p>
            </div>
        {% endif %}
        <a href="/solo" class="mode-button solo">Mic Mode</a>
        <a href="/system" class="mode-button system">System Audio Mode</a>
        <a href="/chat" class="mode-button chat">Chat Mode</a>
        {% if user %}
            <a href="/logout" class="mode-button logout-button">Logout</a>
        {% endif %}
    </div>
</body>
</html>
```

## 步驟七：使用 Docker 執行應用程式

在完成所有程式碼和設定的修改後，使用 Docker Compose 重新建立並執行您的應用程式。

```bash
# 關閉並移除舊的容器
docker-compose down

# 重新建立映像檔並在背景執行
docker-compose up --build -d
```

現在，打開您的瀏覽器並前往 `http://localhost:5002`，您應該會被導向到 Google 登入頁面。登入成功後，您將會看到包含您使用者資訊的模式選擇頁面。

---

## 疑難排解

- **`redirect_uri_mismatch` (錯誤 400):**
  - **原因:** Google API Console 中的「已授權的重新導向 URI」與您的應用程式實際發出的 URI 不符。
  - **解決方案:** 確保您在 Google API Console 中填寫的 URI **完全** 是 `http://localhost:5002/authorize`。檢查有無拼寫錯誤、多餘的斜線或 `http` vs `https` 的問題。

- **`Missing "jwks_uri" in metadata` (內部伺服器錯誤):**
  - **原因:** 應用程式 (在 Docker 容器內) 無法從 Google 的 `server_metadata_url` 取得金鑰設定，可能是因為網路問題。
  - **解決方案:** 我們在 `app.py` 中直接寫死了 `jwks_uri="https://www.googleapis.com/oauth2/v3/certs"`，繞過了自動探索的步驟，從而解決了這個問題。
