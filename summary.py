
import os
import google.generativeai as genai
import logging

# Configure the Gemini model
try:
    model = genai.GenerativeModel(model_name="gemini-2.5-flash-lite")
except Exception as e:
    logging.error(f"Failed to initialize Gemini model in summary.py: {e}")
    model = None

def get_summary_from_text(transcript_text: str, language: str) -> str:
    """
    Generates a summary for the given transcript text using the Gemini API.

    Args:
        transcript_text: The full text of the conversation to be summarized.
        language: The language of the transcript to inform the model.

    Returns:
        A string containing the summary, or an error message.
    """
    if not model:
        return "Error: Summary model is not configured."
    if not transcript_text or not transcript_text.strip():
        return "Nothing to summarize."

    try:
        # Construct a clear and effective prompt
        prompt = (
            f"You are a professional assistant tasked with summarizing a discussion. "
            f"The following text is a transcript of a conversation in {language}. "
            f"Please provide a concise, easy-to-read summary of the key points, decisions, and action items. "
            f"The summary should be in {language}.\n\n"
            f"Transcript:\n"
            f"==========\n"
            f"{transcript_text}\n"
            f"==========\n\n"
            f"Summary:"
        )

        response = model.generate_content(prompt)
        summary = response.text.strip()
        logging.info("Successfully generated summary from transcript.")
        return summary

    except Exception as e:
        logging.error(f"Gemini API error during summarization: {e}")
        return f"Error: Failed to generate summary due to an API error."

