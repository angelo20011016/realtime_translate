// === 下載聊天室內容(txt) ===
document.addEventListener('DOMContentLoaded', function() {
    const downloadChatButton = document.getElementById('downloadChatButton');
    if (downloadChatButton) {
        downloadChatButton.addEventListener('click', function() {
            let chatText = '';
            const reportDiv = document.getElementById('reportDisplay');
            if (reportDiv) {
                chatText = reportDiv.innerText.trim();
            }
            if (!chatText) {
                alert('沒有聊天室內容可下載');
                return;
            }
            const blob = new Blob([chatText], {type: 'text/plain'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'chat.txt';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        });
    }

    // === AI 總結 ===
    const summarizeButton = document.getElementById('summarize-button');
    if (summarizeButton) {
        summarizeButton.addEventListener('click', async function() {
            const reportDiv = document.getElementById('reportDisplay');
            const transcriptText = reportDiv.innerText.trim();
            const sourceLanguage = document.getElementById('sourceLanguage').value;

            if (!transcriptText) {
                alert('沒有內容可以總結。');
                return;
            }

            // Show loading state
            const originalButtonText = summarizeButton.textContent;
            summarizeButton.textContent = '總結中...';
            summarizeButton.disabled = true;

            try {
                const response = await fetch('/summarize_transcript', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ 
                        text: transcriptText, 
                        language: sourceLanguage 
                    }),
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Failed to get summary.');
                }

                const data = await response.json();
                const summary = data.summary;

                // Append summary to the report display
                const summaryContainer = document.createElement('div');
                summaryContainer.className = 'text-container';
                summaryContainer.innerHTML = `
                    <hr>
                    <h4 class="title-font" style="color: var(--accent-cyan);">AI Summary</h4>
                    <p>${summary.replace(/\n/g, '<br>')}</p>
                `;
                reportDiv.appendChild(summaryContainer);
                reportDiv.scrollTop = reportDiv.scrollHeight; // Scroll to the bottom

            } catch (error) {
                console.error('Summarization error:', error);
                alert(`無法產生總結： ${error.message}`);
            } finally {
                // Restore button state
                summarizeButton.textContent = originalButtonText;
                summarizeButton.disabled = false;
            }
        });
    }
});
/*
This file contains the shared logic for all system audio modes.
It declares variables and functions in the global scope for other scripts to use.
*/

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
let inactivityTimer = null;
let lastAudioTime = 0;
const INACTIVITY_TIMEOUT_SECONDS = 60;
let fullTranscript = "";
let socket;
let audioContext;
let processor;
let mediaStream;
let analyser;
let micStream, displayStream;
let animationFrameId;
let forceTranslateTimer = null;

const bufferSize = 2048;
const targetSampleRate = 16000;

// --- Mode-specific handlers (to be assigned by the controller) ---
let onFinalResult = (data) => {};
let onBatchResult = (data) => {};
let onGenerateClick = () => {};

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

    targetLanguageGroup.style.display = isTranslate ? 'block' : 'none';
    micSourceGroup.style.display = (isInterview || isSummarize) ? 'block' : 'none';
    ttsGroup.style.display = (isTranslate || isInterview) ? 'block' : 'none';
    // New visibility logic for the dedicated AI Suggestion button
    document.getElementById('aiSuggestionButton').style.display = isInterview ? 'block' : 'none';
    
    targetLanguageSelect.disabled = !isTranslate;
    audioSourceSelect.disabled = !(isInterview || isSummarize);
    ttsToggle.disabled = !(isTranslate || isInterview);

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
        if (processingModeSelect.value !== 'translate') return; // Only apply to translate mode
        let interimBubble = document.getElementById('interim-bubble');
        if (!interimBubble) {
            interimBubble = document.createElement('div');
            interimBubble.id = 'interim-bubble';
            interimBubble.classList.add('text-container', 'interim'); // Add a class for styling
            reportDisplay.appendChild(interimBubble);
        }
        interimBubble.innerHTML = `<p class="original-text">${data.text}</p>`;
        reportDisplay.scrollTop = reportDisplay.scrollHeight;
    });

    socket.on('final_result', (data) => {
        lastAudioTime = Date.now();
        const interimBubble = document.getElementById('interim-bubble');
        if (interimBubble) interimBubble.remove();
        
        fullTranscript += data.original + " ";
        onFinalResult(data); // Delegate to mode-specific handler
    });

    socket.on('batch_result', (data) => {
        onBatchResult(data); // Delegate to mode-specific handler
    });

    socket.on('report_audio', (data) => {
        const audioBlob = new Blob([new Uint8Array(data.audio)], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play();
        audio.onended = () => URL.revokeObjectURL(audioUrl);
    });

    socket.on('audio_synthesis_result', (data) => {
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

function forceSend() {
    if (!isRecording || !socket || !socket.connected || processingModeSelect.value !== 'translate') return;
    
    console.log("9s timer elapsed. Forcing translation segment.");
    
    // Stop the current recognition cycle on the server.
    // This will trigger a 'final_result' from the server for the audio processed so far.
    socket.emit('stop_translation');
    
    // Immediately start a new recognition cycle on the server.
    // The client-side audio stream is not stopped, so recognition continues seamlessly.
    // Add a small delay to ensure server has time to process the stop command
    setTimeout(() => {
        if (isRecording) { // Check if still recording before restarting
            socket.emit('start_translation', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });
        }
    }, 250);
}

function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body: body });
    } else {
        statusDiv.textContent = body;
    }
}

function checkInactivity() {
    if (!isRecording) {
        clearInterval(inactivityTimer);
        inactivityTimer = null;
        return;
    }
    const inactiveDuration = (Date.now() - lastAudioTime) / 1000;
    if (inactiveDuration > INACTIVITY_TIMEOUT_SECONDS) {
        stopCapture();
        showNotification("Recording Auto-Stopped", `Stopped due to ${INACTIVITY_TIMEOUT_SECONDS}s of inactivity.`);
    }
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

    lastAudioTime = Date.now();
    if (inactivityTimer) clearInterval(inactivityTimer);
    inactivityTimer = setInterval(checkInactivity, 2000);

    if (processingModeSelect.value === 'translate') {
        if (forceTranslateTimer) clearInterval(forceTranslateTimer);
        forceTranslateTimer = setInterval(forceSend, 9000);
    }

    socket.emit('start_translation', {
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
    if (inactivityTimer) {
        clearInterval(inactivityTimer);
        inactivityTimer = null;
    }
    if (forceTranslateTimer) {
        clearInterval(forceTranslateTimer);
        forceTranslateTimer = null;
    }
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

// --- Event Listeners Setup ---
function initializeEventListeners() {
    sidebarToggle.addEventListener('click', () => {
        settingsSidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('active');
    });

    sidebarOverlay.addEventListener('click', () => {
        settingsSidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    });

    captureButton.addEventListener("click", async () => {
        if (isRecording) {
            await stopCapture();
        } else {
            await startCapture();
        }
    });

    generateButton.addEventListener("click", () => {
        onGenerateClick();
    });

    // This was the missing piece from the first refactoring attempt.
    function handleSettingsChange() {
        if (socket && socket.connected) {
            socket.emit('settings_changed', {
                sourceLanguage: sourceLanguageSelect.value,
                targetLanguage: targetLanguageSelect.value,
                ttsEnabled: ttsToggle.checked
            });
        }
    }

    [sourceLanguageSelect, targetLanguageSelect, ttsToggle, audioSourceSelect].forEach(el => {
        el.addEventListener('change', handleSettingsChange);
    });
    
    processingModeSelect.addEventListener('change', updateModeUI);

    // --- New: AI Suggestion Button Listener (moved from system_interview.js) ---
    const aiSuggestionButton = document.getElementById('aiSuggestionButton');
    if (aiSuggestionButton) {
        aiSuggestionButton.addEventListener('click', () => {
            console.log("[DEBUG AI建議] Button clicked. Current mode:", processingModeSelect.value);
            if (processingModeSelect.value !== 'interview') {
                alert('AI 建議功能只在面試教練模式下可用。');
                return;
            }
            // 若正在錄音，先強制送出 final result
            if (isRecording && typeof forceSend === 'function') {
                console.log('[DEBUG AI建議] 正在錄音，先 forceSend');
                forceSend();
                setTimeout(() => {
                    if (!fullTranscript) {
                        alert('沒有逐字稿可以提供建議。');
                        return;
                    }
                    console.log("[DEBUG AI建議] Emitting 'get_ai_suggestion' event (after forceSend) .");
                    statusDiv.textContent = '正在生成 AI 建議...';
                    socket.emit('get_ai_suggestion', {
                        transcript: fullTranscript,
                        sourceLanguage: sourceLanguageSelect.value
                    });
                }, 500);
            } else {
                if (!fullTranscript) {
                    alert('沒有逐字稿可以提供建議。');
                    return;
                }
                console.log("[DEBUG AI建議] Emitting 'get_ai_suggestion' event.");
                statusDiv.textContent = '正在生成 AI 建議...';
                socket.emit('get_ai_suggestion', {
                    transcript: fullTranscript,
                    sourceLanguage: sourceLanguageSelect.value
                });
            }
        });

        // Listen for the dedicated result event (moved from system_interview.js)
        socket.on('ai_suggestion_result', (data) => {
            console.log("[DEBUG AI建議] Received 'ai_suggestion_result'. Current mode:", processingModeSelect.value);
            if (processingModeSelect.value === 'interview') { // Only display if we are still in interview mode
                // 不清空原本內容，直接 append
                const suggestionContainer = document.createElement('div');
                suggestionContainer.className = 'ai-suggestion-container';
                suggestionContainer.innerHTML = `<hr><h4 class="title-font" style="color: var(--accent-cyan);">AI 建議</h4><p>${data.report.replace(/\n/g, '<br>')}</p>`;
                reportDisplay.appendChild(suggestionContainer);
                reportDisplay.scrollTop = reportDisplay.scrollHeight;
                statusDiv.textContent = "AI 建議已生成。";
            } else {
                // 若收到結果時已經不在面試教練模式，不做任何事，保留原內容
                console.log('[DEBUG AI建議] Result received but not in interview mode, ignore update.');
            }
        });
    }
}
