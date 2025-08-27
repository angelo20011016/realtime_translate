# Real-time Speech Translator Demo

This project is a web-based demonstration of a real-time speech translation application. It captures audio from a user's microphone, transcribes it to text using Azure Cognitive Services, and then translates it to another language using the Google Gemini API.

## Features

- **Real-time Audio Capture**: Captures microphone input directly in the browser.
- **Live Speech-to-Text**: Transcribes spoken English into text in real-time.
- **Live Translation**: Translates the transcribed text into Traditional Chinese.
- **Web-Based Interface**: Simple and intuitive interface built with HTML, CSS, and JavaScript.

## Technology Stack

The application is built with a combination of frontend and backend technologies working in concert.

### Backend

- **Python 3**: The core programming language for the server.
- **Flask**: A lightweight web framework used to serve the HTML page and handle requests.
- **Flask-SocketIO**: A Flask extension that enables real-time, bidirectional communication between the client and server using the Socket.IO protocol.
- **Azure Cognitive Services Speech SDK**: Microsoft's powerful SDK used for converting the incoming audio stream into text.
- **Google Gemini API (`google-generativeai`)**: Used to take the transcribed text and translate it into the target language.
- **python-dotenv**: A utility to manage environment variables, keeping API keys and other secrets out of the source code.

### Frontend

- **HTML5 & CSS3**: For the structure and styling of the web page.
- **JavaScript**: For all client-side logic.
- **Socket.IO Client**: The JavaScript client library that connects to the Flask-SocketIO backend, enabling real-time data transfer.
- **Web Audio API (`AudioContext`)**: A powerful browser API used to capture raw audio from the microphone and process it into the required format (16-bit PCM at 16kHz sample rate) before sending it to the backend.

## How It Works (Workflow)

The data flows through the application in the following sequence:

1.  **Audio Capture**: The user clicks "Start Recording" in the browser. The JavaScript frontend uses the **Web Audio API** to access the microphone and capture a raw audio stream.
2.  **Client-Side Processing**: The raw audio is downsampled from the microphone's native sample rate (e.g., 48kHz) to the 16kHz required by the Azure SDK. It is also converted from 32-bit floating-point numbers to 16-bit integers (PCM format).
3.  **Data Transmission**: The processed audio chunks are sent to the backend server over a **Socket.IO** connection using the `audio_data` event.
4.  **Server-Side Reception**: The **Flask-SocketIO** server receives the audio data.
5.  **Speech Recognition**: The data is pushed into an `AudioInputStream` managed by the **Azure Speech SDK**. The SDK performs continuous speech recognition on this stream.
6.  **Translation**: Once the SDK recognizes a complete phrase, the resulting text is passed to the **Gemini API** with a prompt to translate it from English to Traditional Chinese.
7.  **Sending Results**: The backend emits the original transcribed text and the new translated text back to the client via Socket.IO using the `translation_result` event.
8.  **Display**: The frontend JavaScript catches the `translation_result` event and dynamically updates the content of the page to display both the original and translated text to the user.

## Setup and Installation

Follow these steps to run the project locally.

1.  **Prerequisites**: Ensure you have Python 3 installed on your system.

2.  **Create a Virtual Environment**: It is highly recommended to use a virtual environment.
    ```bash
    # Navigate to the project directory
    cd realtime_translator

    # Create a virtual environment
    python3 -m venv venv

    # Activate it (macOS/Linux)
    source venv/bin/activate
    # On Windows, use: venv\Scripts\activate
    ```

3.  **Install Dependencies**: Install all the required Python packages.
    ```bash
    pip install -r requirements.txt
    ```

4.  **Configure Environment Variables**: Create a `.env` file in the root of the `realtime_translator` directory. You can copy the `.env.example` file for the structure.
    ```bash
    cp .env.example .env
    ```
    Now, edit the `.env` file and add your actual API keys from Google and Azure.

5.  **Run the Application**:
    ```bash
    python3 app.py
    ```

6.  **Access the Demo**: Open your web browser and navigate to **http://localhost:5001**.

## File Structure

```
realtime_translator/
├── app.py              # Main Flask/Socket.IO application
├── requirements.txt    # Python dependencies
├── .env.example        # Example environment file
├── static/
│   └── js/
│       └── main.js     # Frontend JavaScript for audio processing and Socket.IO
└── templates/
    └── index.html      # The main HTML page
```
