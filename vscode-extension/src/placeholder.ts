// C01: local placeholder only. Replaced by a backend call in a later card.
export function placeholderReply(input: string): string {
  const text = input.trim();
  if (!text) {
    return "Please enter a question.";
  }
  return `[placeholder] No model is connected yet. You asked: ${text}`;
}
