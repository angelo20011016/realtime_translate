import logging
import google.generativeai as genai

def get_translation_prompt(text, target_lang_code, LANGUAGE_NAMES):
    """
    Generates a prompt for the Gemini model, prioritizing Traditional Chinese (Taiwan).
    Ensures natural, colloquial, and accurate translation, avoiding non-target dialects/scripts.
    """
    target_language_name = LANGUAGE_NAMES.get(target_lang_code, "the target language")
    
    # Explicitly define prompt for better control over translation output when target is Traditional Chinese
    if target_lang_code == "zh-TW":
        prompt = (
            f"You are an expert translator specializing in Taiwanese Mandarin (Traditional Chinese).\n"
            f"Your task is to translate the following spoken input into natural, colloquial, and idiomatic "
            f"Taiwanese Mandarin (Traditional Chinese).\n"
            f"The input may be fragmented, contain pauses, or have ungrammatical phrasing due to real-time speech.\n"
            f"Your goal is to produce a fluent and contextually accurate translation. Avoid using Simplified Chinese characters, "
            f"Cantonese colloquialisms, or any overly formal language.\n\n"
            f"Input speech: '{text}'\n\n"
            f"Please provide ONLY the translated sentence in Traditional Chinese. Do not include any explanations, "
            f"notes, or introductory phrases like 'Here is the translation:'.\n"
            f"Translated sentence:"
        )
    else: # General prompt for other languages (English, Japanese, etc.)
        prompt = (
            f"You are an expert in oral translation. Your task is to translate the user's input into natural, "
            f"colloquial {target_language_name}. The user's input might be fragmented or ungrammatical because it's from real-time speech. "
            f"Refine it and provide a fluent translation. "
            f"Input: '{text}'\n"
            f"Please return only the translated sentence, without any explanation or extra text."
        )
    
    return prompt

def get_batch_prompt(transcript, mode, source_language, LANGUAGE_NAMES):
    """Generates a prompt for batch processing based on the selected mode."""
    source_lang_name = LANGUAGE_NAMES.get(source_language, source_language)

    if mode == 'summarize':
        prompt = (
            f"You are a professional meeting assistant. The following is a transcript of a meeting in {source_lang_name}. "
            f"Please provide a concise summary of the meeting. Identify key decisions made and action items for participants."
            f"\n\nTranscript:\n\n{transcript}"
            f"\n\nSummary:"
        )
    elif mode == 'interview':
        prompt = (
            f"You are an expert interview coach. The following is a transcript of a job interview. The candidate's responses are in {source_lang_name}. "
            f"Please analyze the candidate's responses. Provide constructive feedback on their communication skills, the clarity of their answers, and the overall impression they made. "
            f"Suggest specific areas for improvement. Structure your feedback into sections: Strengths, Areas for Improvement, and Key Takeaways."
            f"\n\nInterview Transcript:\n\n{transcript}"
            f"\n\nFeedback:"
        )
    else:
        prompt = f"Please process the following text: {transcript}"
    
    return prompt
