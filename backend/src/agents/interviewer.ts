import { Type, type FunctionDeclaration } from '@google/genai'

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

export interface InterviewContext {
  candidateName: string
  jobRole: string
  experienceYears: string
  jdText?: string
  jdFileUri?: string
  resumeText?: string
  resumeFileUri?: string
  linkedinUrl?: string
  customInstructions?: string
  useQuestionSet: boolean
  questionSet?: QuestionSet
}

export interface FinalizeResult {
  recommendation: string
  competency_ratings: Array<{ area: string; score: number; justification: string }>
  verified_strengths: string[]
  gaps: string[]
  notable_signals?: string
  followup_areas?: string
  summary: string
}

export function toExperienceLabel(years: string): string {
  if (years === 'Fresher' || years === '1') return 'Junior (0–2y)'
  if (years === '2-3' || years === '3-5') return 'Mid (2–5y)'
  return 'Senior (5+y)'
}

export function buildSystemPromptText(ctx: InterviewContext): string {
  const expLabel = toExperienceLabel(ctx.experienceYears)
  const linkedinLine = ctx.linkedinUrl ? `- LinkedIn: ${ctx.linkedinUrl}` : '- LinkedIn: not provided'

  const jdSection = ctx.jdFileUri
    ? '- Job Description: see attached PDF'
    : ctx.jdText
    ? `- Job Description:\n${ctx.jdText}`
    : ''

  const resumeSection = ctx.resumeFileUri
    ? '- Candidate Resume: see attached PDF'
    : ctx.resumeText
    ? `- Candidate Resume:\n${ctx.resumeText}`
    : ''

  const customSection = ctx.customInstructions
    ? `\n## ADDITIONAL INSTRUCTIONS FROM HR\n${ctx.customInstructions}\n`
    : ''

  const competencySection =
    ctx.useQuestionSet && ctx.questionSet
      ? `\n## SUGGESTED COMPETENCY AREAS (from HR question bank)\nHR has pre-selected the following areas for this role. Use them as your 4–5 competency anchors. Generate questions adaptively — do not read verbatim:\n${ctx.questionSet.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}\n`
      : ''

  return `You are an expert technical interviewer for Wohlig Transformations conducting a live, voice-style technical interview. You are professional, warm, and sharp. Your goal is to accurately assess the candidate's real technical depth — not to quiz them against a fixed script.

## INPUTS PROVIDED
- Job Role: ${ctx.jobRole}
- Experience Level: ${expLabel}
${linkedinLine}
${jdSection}
${resumeSection}
${customSection}${competencySection}
## INTERVIEW DURATION
- Total: 20–30 min scaled to level.
  - Junior: ~20 min, 3–4 areas.
  - Mid: ~25 min, 4–5 areas.
  - Senior: ~30 min, 4–5 areas probed to greater depth.
- Track elapsed time mentally. When ~5 min remain, begin wrapping up. Do not exceed 30 minutes.

## CORE PRINCIPLE: THIS IS A CONVERSATION, NOT A QUESTIONNAIRE
1. Before starting, silently analyse the JD + resume + LinkedIn to identify 4–5 key competency areas most relevant to the role.
2. Ask ONE question at a time. Then LISTEN.
3. Your next question is generated dynamically from the candidate's actual answer — dig into what they said, don't jump to an unrelated topic.

## ADAPTIVE FOLLOW-UP LOGIC
For each answer:
- Strong and complete → acknowledge briefly, move to next competency area.
- Vague or shallow → probe deeper on SAME topic: "why", "how would you handle X", "what happens if…", "walk me through the tradeoff". Keep probing until satisfied.
- Clearly struggling → one clarifying variant, then gracefully move on.
- Escalate difficulty when candidate handles a topic easily; de-escalate when struggling. Calibrate live to find the edge of their ability.

## GROUNDING IN THEIR BACKGROUND
- Pull specifics from the resume/LinkedIn. Reference actual projects, companies, or tech they listed.
- Cross-check claims: if they list a skill, verify it with a real question.

## HANDLING CANDIDATE CROSS-QUESTIONS
- Answer clarifying questions directly and helpfully.
- If they push back with sound reasoning, acknowledge it — a good candidate correcting you is a strong signal.
- Do not get defensive. Treat it as a real technical dialogue between peers.

## TONE & CONDUCT
- One question per turn. Keep your turns concise — you should talk less than the candidate.
- Never dump multiple questions at once.
- Brief acknowledgements ("Makes sense", "Good — and…") then the next probe.
- Never reveal ideal answers or hint at scoring.
- Stay in role. If asked something off-topic, redirect gently.

## STRUCTURE
1. Warm 2-line intro: greet ${ctx.candidateName}, state this is a ~20–30 min technical chat, invite them to think aloud and ask questions anytime.
2. Optional light opener: one question about a project from their resume to settle nerves.
3. Core: 4–5 competency areas, each explored via the adaptive follow-up loop.
4. Wrap-up (~last 3–5 min): invite the candidate's questions, thank them, close. Do not announce a verdict.

## SCORING
Call score_competency() silently after you have fully assessed each competency area.
Call end_interview() after the wrap-up concludes.

SCORING RUBRIC (1–5):
1 — No meaningful understanding
2 — Surface knowledge only
3 — Solid working knowledge
4 — Strong, nuanced understanding with practical knowledge
5 — Expert: detailed, insightful, demonstrates real-world mastery`.trim()
}

export const interviewerTools: FunctionDeclaration[] = [
  {
    name: 'score_competency',
    description: "Score the candidate's performance on a completed competency area",
    parameters: {
      type: Type.OBJECT,
      properties: {
        area: {
          type: Type.STRING,
          description: 'Competency area label, e.g. "React state management" or "System design"',
        },
        score: { type: Type.NUMBER, description: 'Score from 1 to 5' },
        notes: {
          type: Type.STRING,
          description: 'One-line evaluation grounded in what the candidate actually said',
        },
      },
      required: ['area', 'score', 'notes'],
    },
  },
  {
    name: 'end_interview',
    description: 'End the interview after wrap-up and provide structured assessment',
    parameters: {
      type: Type.OBJECT,
      properties: {
        recommendation: {
          type: Type.STRING,
          description: 'One of: "Strong Hire", "Hire", "Lean No", "No Hire"',
        },
        competency_ratings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              area: { type: Type.STRING },
              score: { type: Type.NUMBER },
              justification: { type: Type.STRING },
            },
          },
          description: 'Per-competency ratings with one-line justification grounded in what candidate said',
        },
        verified_strengths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Skills or claims the candidate confirmed under questioning',
        },
        gaps: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Weak areas or claims that did not hold up under probing',
        },
        notable_signals: {
          type: Type.STRING,
          description: 'Positive signals: good cross-questions, curiosity, communication quality',
        },
        followup_areas: {
          type: Type.STRING,
          description: 'Suggested areas for the next interview round',
        },
        summary: {
          type: Type.STRING,
          description: 'Two to three sentence overall summary of candidate performance',
        },
      },
      required: ['recommendation', 'competency_ratings', 'verified_strengths', 'gaps', 'summary'],
    },
  },
]

interface DB {
  saveScore(sessionId: string, area: string, score: number, notes: string): Promise<void>
  finalizeSession(sessionId: string, result: FinalizeResult): Promise<void>
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  db: DB,
): Promise<Record<string, unknown>> {
  if (name === 'score_competency') {
    await db.saveScore(
      sessionId,
      args['area'] as string,
      args['score'] as number,
      args['notes'] as string,
    )
    return { saved: true }
  }

  if (name === 'end_interview') {
    await db.finalizeSession(sessionId, {
      recommendation: args['recommendation'] as string,
      competency_ratings: args['competency_ratings'] as FinalizeResult['competency_ratings'],
      verified_strengths: args['verified_strengths'] as string[],
      gaps: args['gaps'] as string[],
      notable_signals: args['notable_signals'] as string | undefined,
      followup_areas: args['followup_areas'] as string | undefined,
      summary: args['summary'] as string,
    })
    return { ended: true }
  }

  return { error: `Unknown function: ${name}` }
}
