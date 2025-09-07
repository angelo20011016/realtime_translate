document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Elements ---
    const captureButton = document.getElementById("captureButton");
    const generateButton = document.getElementById("generateButton");
    const statusDiv = document.getElementById("status");
    const sourceLanguageSelect = document.getElementById("sourceLanguage");
    const targetLanguageSelect = document.getElementById("targetLanguage");
    const audioSourceSelect = document.getElementById("audioSource");
    const ttsToggle = document.getElementById("ttsToggle");
    const processingModeSelect = document.getElementById("processingMode");
    const transcriptDisplay = document.getElementById("transcriptDisplay");
    const reportDisplay = document.getElementById("reportDisplay");
    const vuMeterLevel = document.getElementById('vu-meter-level');
    const settingsSidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const targetLanguageGroup = document.getElementById('targetLanguageGroup');
    const ttsGroup = document.getElementById('ttsGroup');
    const micSourceGroup = document.getElementById('micSourceGroup');

    // --- State Variables ---
    let isRecording = false;
    let fullTranscript = "";
    let socket;
    let audioContext;
    let processor;
    let mediaStream;
    let analyser;
    let micStream, displayStream;

    const bufferSize = 2048;
    const targetSampleRate = 16000;

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
        sourceLanguageSelect.disabled = !enabled;
        processingModeSelect.disabled = !enabled;
        if (enabled) {
            updateModeUI();
        } else {
            targetLanguageSelect.disabled = true;
            ttsToggle.disabled = true;
            audioSourceSelect.disabled = true;
        }
    }

    function updateModeUI() {
        const mode = processingModeSelect.value;
        const isTranslate = mode === 'translate';
        const isInterview = mode === 'interview';
        const isSummarize = mode === 'summarize';

        // Show/hide controls based on the selected mode
        targetLanguageGroup.style.display = isTranslate ? 'block' : 'none';
        micSourceGroup.style.display = (isInterview || isSummarize) ? 'block' : 'none';
        ttsGroup.style.display = (isTranslate || isInterview) ? 'block' : 'none';
        
        // Enable/disable controls to prevent interaction when hidden
        targetLanguageSelect.disabled = !isTranslate;
        audioSourceSelect.disabled = !(isInterview || isSummarize);
        ttsToggle.disabled = !(isTranslate || isInterview);

        // Show the generate button only for batch modes and only after capture has started
        if (isRecording) {
            generateButton.style.display = (isInterview || isSummarize) ? 'block' : 'none';
        } else {
            generateButton.style.display = 'none';
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
        if (socket && socket.connected) return;

        socket = io({ reconnection: false });

        socket.on('connect', () => {
            console.log("Socket connected.");
            statusDiv.textContent = "Connected. Ready to capture.";
        });

        socket.on('interim_result', (data) => {
            // Update transcriptDisplay to show only the current interim result
            transcriptDisplay.innerHTML = `<p class="original-text">${data.text}</p>`;
            transcriptDisplay.scrollTop = transcriptDisplay.scrollHeight;
        });

        socket.on('final_result', (data) => {
            // Clear interim display
            transcriptDisplay.innerHTML = "";
            fullTranscript += data.original + " ";

            if (processingModeSelect.value === 'translate') {
                const entryDiv = document.createElement('div');
                entryDiv.classList.add('text-container'); // Use the new text-container class
                const originalP = document.createElement('p');
                originalP.classList.add('original-text');
                originalP.textContent = data.original;
                entryDiv.appendChild(originalP);
                const translatedP = document.createElement('p');
                translatedP.classList.add('translated-text');
                translatedP.textContent = data.refined;
                entryDiv.appendChild(translatedP);
                reportDisplay.appendChild(entryDiv);
                reportDisplay.scrollTop = reportDisplay.scrollHeight;
            } else {
                // For other modes (summarize, interview), append original transcript to reportDisplay
                // This part needs to be handled carefully based on how these modes are expected to display
                // For now, I'll just append the original text as a simple paragraph if not in translate mode
                const p = document.createElement('p');
                p.textContent = data.original;
                reportDisplay.appendChild(p);
                reportDisplay.scrollTop = reportDisplay.scrollHeight;
            }
        });

        socket.on('batch_result', (data) => {
            reportDisplay.innerHTML = '';
            const p = document.createElement('p');
            p.textContent = data.report;
            reportDisplay.appendChild(p);
            statusDiv.textContent = "Report generated.";
            if (ttsToggle.checked && processingModeSelect.value === 'interview') {
                socket.emit('request_report_audio', { text: data.report });
            }
        });

        socket.on('report_audio', (data) => {
            const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
            audio.onended = () => URL.revokeObjectURL(audioUrl);
        });

        socket.on('audio_synthesis_result', (data) => { // For real-time translation TTS
            const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
            audio.onended = () => URL.revokeObjectURL(audioUrl);
        });

        socket.on('server_error', (data) => {
            console.error("Server error:", data.error);
            statusDiv.textContent = `Error: ${data.error}`;
            stopCapture();
        });

        socket.on('disconnect', () => {
            console.log("Socket disconnected.");
            statusDiv.textContent = "Disconnected. Please refresh.";
            stopCapture();
        });
    }

    function setupAudioProcessing(stream) {
        mediaStream = stream;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
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
        const level = Math.min(1, rms / 0.5) * 100;
        vuMeterLevel.style.width = level + '%';
        animationFrameId = requestAnimationFrame(updateVUMeter);
    }

    async function startCapture() {
        if (!socket || !socket.connected) {
            statusDiv.textContent = "Not connected. Please wait.";
            return;
        }
        isRecording = true;
        fullTranscript = "";
        transcriptDisplay.innerHTML = "";
        reportDisplay.innerHTML = "";
        captureButton.textContent = "Stop Capture";
        captureButton.classList.add("recording");
        statusDiv.textContent = "Requesting audio access...";
        setSettingsEnabled(false);

        socket.emit('start_translation', { // This event now just sets up the recognizer on the backend
            sourceLanguage: sourceLanguageSelect.value,
            targetLanguage: targetLanguageSelect.value,
            ttsEnabled: ttsToggle.checked
        });

        try {
            const mode = processingModeSelect.value;
            const needsMic = mode === 'summarize' || mode === 'interview';

            displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            if (displayStream.getAudioTracks().length === 0) {
                alert("System audio sharing is required. Please try again.");
                throw new Error("No system audio shared.");
            }

            let finalStream;
            if (needsMic) {
                micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: audioSourceSelect.value } } });
                
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const systemSource = audioContext.createMediaStreamSource(displayStream);
                const micSource = audioContext.createMediaStreamSource(micStream);
                const destination = audioContext.createMediaStreamDestination();
                
                systemSource.connect(destination);
                micSource.connect(destination);
                
                finalStream = destination.stream;
            } else {
                finalStream = displayStream;
            }

            displayStream.getVideoTracks().forEach(track => track.stop());
            setupAudioProcessing(finalStream);
            statusDiv.textContent = "Capturing...";

        } catch (err) {
            console.error("Error starting capture:", err);
            statusDiv.textContent = `Error: ${err.message}`;
            await stopCapture();
        }
    }

    async function stopCapture() {
        if (!isRecording) return;
        isRecording = false;

        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        vuMeterLevel.style.width = '0%';
        
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        if (micStream) micStream.getTracks().forEach(track => track.stop());
        if (displayStream) displayStream.getTracks().forEach(track => track.stop());

        if (processor) {
            processor.disconnect();
            processor.onaudioprocess = null;
        }
        if (analyser) analyser.disconnect();
        if (audioContext && audioContext.state !== 'closed') {
            await audioContext.close();
        }

        mediaStream = micStream = displayStream = audioContext = analyser = processor = null;

        captureButton.textContent = "Start Capture";
        captureButton.classList.remove("recording");
        statusDiv.textContent = "Capture stopped.";
        setSettingsEnabled(true);

        if (socket && socket.connected) socket.emit('stop_translation');
    }

    captureButton.addEventListener("click", async () => {
        if (isRecording) {
            await stopCapture();
        } else {
            await startCapture();
        }
    });

    generateButton.addEventListener("click", () => {
        if (!fullTranscript) {
            statusDiv.textContent = "No transcript to process.";
            return;
        }
        statusDiv.textContent = `Sending transcript for ${processingModeSelect.value}...`;
        socket.emit('process_batch', {
            transcript: fullTranscript,
            mode: processingModeSelect.value,
            sourceLanguage: sourceLanguageSelect.value
        });
    });

    processingModeSelect.addEventListener('change', updateModeUI);

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
    setSettingsEnabled(true);
    connectSocket();
    populateAudioInputDevices();
});
