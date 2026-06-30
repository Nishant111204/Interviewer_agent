// @google/adk v0.1.3 exports LlmAgent (not Agent) and FunctionTool (not a tool() helper).
// The brief was written against a pre-release API shape. We adapt accordingly.
// Schema.type requires the Type enum from @google/genai (not plain string literals).
import { LlmAgent, FunctionTool } from '@google/adk'
import { Type } from '@google/genai'

export interface Question {
  id: string
  text: string
  expected_answer?: string
  weight: number
}

export interface QuestionSet {
  id: string
  name: string
  role: string
  questions: Question[]
}

// Default question set for frontend developer role
export const frontendQuestionSet: QuestionSet = {
  id: 'fe-default',
  name: 'Frontend Developer',
  role: 'Frontend Developer',
  questions: [
    {
      id: 'fe-1',
      text: 'Can you walk me through how you would optimize a React application that is rendering slowly?',
      expected_answer: 'memoization, virtualization, code splitting, avoiding unnecessary re-renders, profiling',
      weight: 2,
    },
    {
      id: 'fe-2',
      text: 'Explain the difference between `useEffect` with no dependency array, an empty array, and a populated array.',
      expected_answer: 'runs after every render / once on mount / when deps change',
      weight: 1.5,
    },
    {
      id: 'fe-3',
      text: 'How would you implement accessibility (a11y) in a custom dropdown component?',
      expected_answer: 'ARIA roles, keyboard navigation, focus management, screen reader support',
      weight: 1,
    },
    {
      id: 'fe-4',
      text: 'Describe the CSS box model and how `box-sizing: border-box` changes it.',
      expected_answer: 'content + padding + border + margin; border-box includes padding and border in width/height',
      weight: 1,
    },
    {
      id: 'fe-5',
      text: 'You have a web page that loads 4 seconds on mobile. What is your diagnostic and optimization process?',
      expected_answer: 'Lighthouse, network waterfall, image optimization, lazy loading, bundle size, TTFB, CDN',
      weight: 2,
    },
  ],
}

interface DB {
  saveScore(sessionId: string, questionId: string, score: number, notes: string): Promise<void>
  finalizeSession(sessionId: string, recommendation: string, summary: string): Promise<void>
}

export function createInterviewerAgent(
  questionSet: QuestionSet,
  sessionId: string,
  db: DB,
  candidateName: string,
) {
  // NOTE: @google/adk v0.1.3 uses FunctionTool class (not a `tool()` helper as shown in the brief).
  // The Schema.type field requires the Type enum from @google/genai (not plain string literals).

  const scoreAnswer = new FunctionTool({
    name: 'score_answer',
    description: "Score the candidate's answer to the current question",
    parameters: {
      type: Type.OBJECT,
      properties: {
        question_id: { type: Type.STRING, description: 'The question ID being scored' },
        score: { type: Type.NUMBER, description: 'Score from 1 to 10' },
        notes: { type: Type.STRING, description: 'Brief evaluation notes for the HR report' },
      },
      required: ['question_id', 'score', 'notes'],
    },
    execute: async (input: unknown) => {
      const { question_id, score, notes } = input as { question_id: string; score: number; notes: string }
      await db.saveScore(sessionId, question_id, score, notes)
      return { saved: true }
    },
  })

  const endInterview = new FunctionTool({
    name: 'end_interview',
    description: 'End the interview after all questions are complete and provide final recommendation',
    parameters: {
      type: Type.OBJECT,
      properties: {
        recommendation: {
          type: Type.STRING,
          description: 'Hiring recommendation: one of "Strong Hire", "Hire", or "No Hire"',
        },
        summary: {
          type: Type.STRING,
          description: 'Two to three sentence summary of the candidate performance',
        },
      },
      required: ['recommendation', 'summary'],
    },
    execute: async (input: unknown) => {
      const { recommendation, summary } = input as { recommendation: string; summary: string }
      await db.finalizeSession(sessionId, recommendation, summary)
      return { ended: true }
    },
  })

  const questions = questionSet.questions
    .map((q, i) => `${i + 1}. [ID: ${q.id}] ${q.text}`)
    .join('\n')

  return new LlmAgent({
    model: 'gemini-live-2.5-flash',
    name: 'interviewer',
    instruction: `
You are a professional technical interviewer for Wohlig Transformations conducting a ${questionSet.role} interview.

INTERVIEW FLOW:
1. Greet ${candidateName} warmly by name. Tell them the interview will take about 20 minutes and you will ask ${questionSet.questions.length} questions.
2. Ask the questions below ONE AT A TIME in order.
3. After each answer: if vague or incomplete, ask exactly ONE follow-up to probe deeper. Do not ask more than one follow-up per question.
4. Silently call score_answer() after each complete answer. Do not tell the candidate their score.
5. After all ${questionSet.questions.length} questions are answered, thank the candidate warmly, then call end_interview().

TONE: Professional, calm, encouraging. Natural conversational pauses. Not robotic.

QUESTIONS:
${questions}

SCORING RUBRIC (1–10):
- 1–3: Incorrect or very shallow understanding
- 4–6: Partially correct, lacks depth or specifics
- 7–8: Good, clear understanding with practical knowledge
- 9–10: Excellent, detailed, demonstrates real expertise

Do NOT tell the candidate their scores. Do NOT rush through questions.
Do NOT ask two questions at once. Wait for a complete answer before scoring and moving on.
    `.trim(),
    tools: [scoreAnswer, endInterview],
  })
}
