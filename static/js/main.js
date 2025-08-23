document.addEventListener("DOMContentLoaded", () => {
    const recordButton = document.getElementById("recordButton");
    const statusDiv = document.getElementById("status");
    const originalTextDiv = document.getElementById("originalText");
    const translatedTextDiv = document.getElementById("translatedText");
    const sourceLanguageSelect = document.getElementById("sourceLanguage");
    const targetLanguageSelect = document.getElementById("targetLanguage");
    const ttsToggle = document.getElementById("ttsToggle");
    const originalTextLabel = document.getElementById("original-text-label");
    const translatedTextLabel = document.getElementById("translated-text-label");

    let isRecording = false;
    let socket;
    let audioContext;
    let processor;
    let source;
    const bufferSize = 2048;
    const targetSampleRate = 16000;

    recordButton.addEventListener("click", () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    function updateLanguageLabels() {
        const sourceLangText = sourceLanguageSelect.options[sourceLanguageSelect.selectedIndex].text;
        const targetLangText = targetLanguageSelect.options[targetLanguageSelect.selectedIndex].text;
        originalTextLabel.textContent = `Original (${sourceLangText})`;
        translatedTextLabel.textContent = `Translation (${targetLangText})`;
    }

    sourceLanguageSelect.addEventListener("change", updateLanguageLabels);
    targetLanguageSelect.addEventListener("change", updateLanguageLabels);

    function startRecording() {
        isRecording = true;
        recordButton.textContent = "Stop Recording";
        recordButton.classList.add("recording");
        statusDiv.textContent = "Connecting to server...";
        originalTextDiv.textContent = "";
        translatedTextDiv.textContent = "";
        updateLanguageLabels();

        socket = io();

        socket.on('connect', () => {
            statusDiv.textContent = "Connected. Start speaking...";
            console.log("Socket connected, emitting start_translation");

            // Send settings to the server
            socket.emit('start_translation', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });

            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then(stream => {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    source = audioContext.createMediaStreamSource(stream);
                    processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

                    processor.onaudioprocess = (e) => {
                        if (!isRecording || !socket.connected) return;

                        const inputData = e.inputBuffer.getChannelData(0);
                        const downsampledBuffer = downsample(inputData, audioContext.sampleRate, targetSampleRate);
                        const pcm16Buffer = toPCM16(downsampledBuffer);
                        
                        socket.emit('audio_data', pcm16Buffer);
                    };

                    source.connect(processor);
                    processor.connect(audioContext.destination);
                })
                .catch(err => {
                    console.error("Error getting media stream:", err);
                    statusDiv.textContent = `Error: ${err.message}`;
                    stopRecording();
                });
        });

        socket.on('interim_result', (data) => {
            originalTextDiv.textContent = data.text;
        });

        socket.on('final_result', (data) => {
            originalTextDiv.textContent = data.original;
            translatedTextDiv.textContent = data.refined;
        });

        socket.on('audio_synthesis_result', (data) => {
            const audioBlob = new Blob([data.audio], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
        });

        socket.on('translation_error', (data) => {
            console.error("Translation error:", data.error);
            statusDiv.textContent = `Error: ${data.error}`;
        });

        socket.on('disconnect', () => stopRecording());
        socket.on('connect_error', (error) => {
            console.error('Connection Error:', error);
            statusDiv.textContent = 'Connection failed. Please try again.';
            stopRecording();
        });
    }

    function stopRecording() {
        if (!isRecording) return;
        isRecording = false;

        recordButton.textContent = "Start Recording";
        recordButton.classList.remove("recording");
        statusDiv.textContent = "Click 'Start Recording' and begin speaking.";

        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (audioContext) audioContext.close();
        if (socket && socket.connected) socket.disconnect();
    }

    function downsample(buffer, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) {
            return buffer;
        }
        const sampleRateRatio = fromSampleRate / toSampleRate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
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

    // Initialize labels on page load
    updateLanguageLabels();
});
