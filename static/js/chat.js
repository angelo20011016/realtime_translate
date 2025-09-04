document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Elements ---
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const myLanguageSelect = document.getElementById("myLanguage");
    const audioSourceSelect = document.getElementById("audioSource");
    const ttsToggle = document.getElementById("ttsToggle");
    const chatMessagesDisplay = document.getElementById("chatMessages");
    const interimDisplay = document.getElementById("interimDisplay");
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const roomIdInput = document.getElementById('roomId');
    const userIdInput = document.getElementById('userId');
    const joinRoomButton = document.getElementById('joinRoomButton');
    const userList = document.getElementById('userList');

    // --- State Variables ---
    let isRecording = false;
    let socket;
    let audioContext;
    let processor;
    let source;
    let mediaStream;
    let analyser;
    let reconnectInterval;
    let animationFrameId;
    const bufferSize = 2048;
    const targetSampleRate = 16000;
    const audioQueue = [];
    let isPlayingAudio = false;
    let currentRoomId = null;
    let currentUserId = null;

    // --- Sidebar Logic ---
    sidebarToggle.addEventListener('click', () => {
        settingsSidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('active');
    });

    sidebarOverlay.addEventListener('click', () => {
        settingsSidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    });

    // --- Core Functions ---
    function setSettingsEnabled(enabled) {
        // myLanguageSelect.disabled = !enabled; // REMOVE THIS LINE
        // audioSourceSelect.disabled = !enabled; // REMOVE THIS LINE
        ttsToggle.disabled = !enabled;
            function setSettingsEnabled(enabled) {
        ttsToggle.disabled = !enabled;
        // recordButton.disabled = !enabled; // REMOVE THIS LINE
    }
    }

    async function populateAudioInputDevices() {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
            
            audioSourceSelect.innerHTML = '';
            if (audioInputDevices.length === 0) {
                audioSourceSelect.innerHTML = '<option>No microphones found</option>';
                return;
            }

            audioInputDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${audioSourceSelect.length + 1}`;
                audioSourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error("Could not get audio devices:", err);
            statusDiv.textContent = "Microphone access denied.";
            audioSourceSelect.innerHTML = '<option>Permission denied</option>';
        }
    }

    function connectSocket() {
        if (socket && socket.connected) {
            if (isRecording) {
                statusDiv.textContent = "Connected. Start to speak.";
                startAudioCaptureAndEmitSettings();
            }
            return;
        }

        socket = io({ reconnection: false });

        socket.on('connect', () => {
            console.log("Socket connected.");
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
            if (currentRoomId && currentUserId) {
                socket.emit('join_room', { roomId: currentRoomId, userId: currentUserId, language: myLanguageSelect.value });
            }
            if (isRecording) {
                statusDiv.textContent = "Connected. Start to speak.";
                startAudioCaptureAndEmitSettings();
            }
        });

        socket.on('interim_result', (data) => { interimDisplay.textContent = data.text; });

        socket.on('chat_message', (data) => {
            interimDisplay.textContent = "";
            if (!data.original) return;

            const messageBubble = document.createElement('div');
            messageBubble.classList.add('message-bubble');
            messageBubble.classList.add(data.senderId === currentUserId ? 'sent' : 'received');

            const messageContent = document.createElement('div');
            messageContent.classList.add('message-content');

            const senderInfo = document.createElement('p');
            senderInfo.classList.add('sender-info');
            senderInfo.textContent = data.senderId + ":";
            messageContent.appendChild(senderInfo);

            const originalP = document.createElement('p');
            originalP.classList.add('original-text');
            originalP.textContent = data.original;
            messageContent.appendChild(originalP);

            const translatedP = document.createElement('p');
            translatedP.classList.add('translated-text');
            translatedP.textContent = data.translated;
            messageContent.appendChild(translatedP);

            messageBubble.appendChild(messageContent);
            chatMessagesDisplay.appendChild(messageBubble);
            chatMessagesDisplay.scrollTop = chatMessagesDisplay.scrollHeight;

            if (ttsToggle.checked && data.senderId !== currentUserId) {
                // Play TTS for received messages if TTS is enabled and it's not my own message
                const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
                audioQueue.push(audioBlob);
                playNextInQueue();
            }
        });

        socket.on('room_update', (data) => {
            userList.innerHTML = '';
            data.users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = user.userId;
                if (user.userId === currentUserId) {
                    li.classList.add('self');
                }
                userList.appendChild(li);
            });
        });

        socket.on('server_error', (data) => {
            console.error("Server error:", data.error);
            statusDiv.textContent = `Error: ${data.error}`;
            stopRecording();
        });

        socket.on('disconnect', () => {
            console.log("Socket disconnected.");
            statusDiv.textContent = "Disconnected. Attempting to reconnect...";
            stopAudioCapture();
            if (!reconnectInterval) {
                reconnectInterval = setInterval(() => {
                    if (!socket.connected) {
                        console.log("Attempting to reconnect...");
                        socket.connect();
                    }
                }, 3000);
            }
        });

        socket.on('connect_error', (error) => {
            console.error('Connection Error:', error);
            statusDiv.textContent = 'Connection failed. Retrying...';
        });
    }

    function playNextInQueue() {
        if (isPlayingAudio || audioQueue.length === 0) {
            return;
        }
        isPlayingAudio = true;
        const audioBlob = audioQueue.shift();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play().catch(e => {
            console.error("Error playing TTS audio:", e);
            isPlayingAudio = false;
        });
        audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            isPlayingAudio = false;
            playNextInQueue();
        };
    }

    function startAudioCaptureAndEmitSettings() {
        statusDiv.textContent = "Microphone connected. Connecting to server...";
        socket.emit('start_chat_translation', {
            language: myLanguageSelect.value,
            ttsEnabled: ttsToggle.checked,
            roomId: currentRoomId,
            userId: currentUserId
        });

        const constraints = { audio: { deviceId: { exact: audioSourceSelect.value } }, video: false };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(stream => {
                mediaStream = stream;
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                source = audioContext.createMediaStreamSource(stream);
                processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 256;

                processor.onaudioprocess = (e) => {
                    if (!isRecording || !socket.connected) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    const downsampledBuffer = downsample(inputData, audioContext.sampleRate, targetSampleRate);
                    const pcm16Buffer = toPCM16(downsampledBuffer);
                    socket.emit('audio_data', pcm16Buffer);
                };

                source.connect(analyser);
                analyser.connect(processor);
                processor.connect(audioContext.destination);
                
                updateVUMeter();
                if (socket.connected) {
                    statusDiv.textContent = "Connected. Start to speak.";
                }
            })
            .catch(err => {
                console.error("Error getting media stream:", err);
                statusDiv.textContent = `Mic Error: ${err.message}`;
                stopRecording();
            });
    }

    function updateVUMeter() {
        if (!isRecording || !analyser) {
            vuMeterLevel.style.width = '0%';
            return;
        }
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0.0;
        for (const amplitude of dataArray) {
            const normalized = (amplitude / 128.0) - 1.0;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const maxLevel = 0.5;
        const level = Math.min(1, rms / maxLevel) * 100;
        vuMeterLevel.style.width = level + '%';

        animationFrameId = requestAnimationFrame(updateVUMeter);
    }

    recordButton.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    function startRecording() {
        if (!currentRoomId || !currentUserId) {
            statusDiv.textContent = "Please join a room first.";
            return;
        }
        isRecording = true;
        recordButton.textContent = "Stop Speaking";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Requesting microphone access...";
        interimDisplay.textContent = "Listening...";
        setSettingsEnabled(false);
        startAudioCaptureAndEmitSettings();
    }

    function stopAudioCapture() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        vuMeterLevel.style.width = '0%';
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (analyser) analyser.disconnect();
        if (audioContext) audioContext.close();
        mediaStream = null;
        audioContext = null;
        analyser = null;
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start Speaking";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Speaking' and begin speaking.";
        interimDisplay.textContent = "";
        setSettingsEnabled(true);

        stopAudioCapture();
        audioQueue.length = 0;
        isPlayingAudio = false;

        if (socket && socket.connected) socket.emit('stop_translation');
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    }

    function handleSettingsChange() {
        if (socket && socket.connected && isRecording) {
            console.log("Settings changed while recording, re-initializing...");
            stopAudioCapture();
            startAudioCaptureAndEmitSettings();
        } else if (socket && socket.connected && currentRoomId && currentUserId) {
            // If not recording but connected to a room, just update language setting on server
            socket.emit('update_user_settings', { language: myLanguageSelect.value, ttsEnabled: ttsToggle.checked });
        }
    }

    [myLanguageSelect, audioSourceSelect, ttsToggle].forEach(el => {
        el.addEventListener('change', handleSettingsChange);
    });

    joinRoomButton.addEventListener('click', () => {
        const roomId = roomIdInput.value.trim();
        const userId = userIdInput.value.trim();

        if (!roomId || !userId) {
            statusDiv.textContent = "Please enter both Room ID and Your ID.";
            return;
        }

        currentRoomId = roomId;
        currentUserId = userId;
        joinRoomButton.disabled = true;
        roomIdInput.disabled = true;
        userIdInput.disabled = true;
        statusDiv.textContent = `Joining room ${currentRoomId} as ${currentUserId}...`;
        connectSocket(); // Connects or re-uses existing socket
        setSettingsEnabled(true); // Enable TTS and Record button after joining
    });

    function downsample(buffer, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) return buffer;
        const sampleRateRatio = fromSampleRate / toSampleRate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0, offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = accum / count;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    function toPCM16(input) {
        const buffer = new ArrayBuffer(input.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return buffer;
    }

    // Initial setup
    setSettingsEnabled(false); // Disable settings until room is joined
    populateAudioInputDevices();
});