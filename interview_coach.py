
import os
import google.generativeai as genai
import logging

# Configure the Gemini model specifically for the coach
try:
    model = genai.GenerativeModel(model_name="gemini-2.5-flash-lite")
except Exception as e:
    logging.error(f"Failed to initialize Gemini model in interview_coach.py: {e}")
    model = None

def get_interview_feedback(transcript: str, language: str) -> str:
    """
    Generates structured interview feedback using a specific persona.

    Args:
        transcript: The full text of the interview session.
        language: The language of the transcript.

    Returns:
        A string containing structured feedback, or an error message.
    """
    if not model:
        return "Error: Interview Coach model is not configured."
    if not transcript or not transcript.strip():
        return "Nothing to analyze."

    try:
        prompt = f"""
你是一個專業的面試教練，請以資深面試官的角度，分析以下面試對話，並給出三個能立即幫助使用者加分的具體建議。\n\n面試對話內容：\n{transcript}\n\n請用 {language} 回答。 回答僅限5個句子之內
"""
        response = model.generate_content(prompt)
        feedback = response.text.strip()
        logging.info("Successfully generated interview feedback via dedicated module.")
        return feedback

    except Exception as e:
        logging.error(f"Gemini API error during interview feedback generation: {e}")
        return f"Error: Failed to generate interview feedback due to an API error."

