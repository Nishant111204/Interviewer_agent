import { toExperienceLabel, buildSystemPromptText, InterviewContext } from '../interviewer'

describe('toExperienceLabel', () => {
  it('maps Fresher to Junior label', () => {
    expect(toExperienceLabel('Fresher')).toBe('Junior (0–2y)')
  })
  it('maps 1 to Junior label', () => {
    expect(toExperienceLabel('1')).toBe('Junior (0–2y)')
  })
  it('maps 2-3 to Mid label', () => {
    expect(toExperienceLabel('2-3')).toBe('Mid (2–5y)')
  })
  it('maps 3-5 to Mid label', () => {
    expect(toExperienceLabel('3-5')).toBe('Mid (2–5y)')
  })
  it('maps 5+ to Senior label', () => {
    expect(toExperienceLabel('5+')).toBe('Senior (5+y)')
  })
})

describe('buildSystemPromptText', () => {
  const base: InterviewContext = {
    candidateName: 'Jane',
    jobRole: 'SDE',
    experienceYears: '2-3',
    useQuestionSet: false,
  }

  it('includes candidate name in intro', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).toContain('Jane')
  })

  it('includes experience label not raw value', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).toContain('Mid (2–5y)')
    expect(prompt).not.toContain('2-3')
  })

  it('includes jd_text inline when no file URI', () => {
    const ctx = { ...base, jdText: 'Build scalable APIs' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('Build scalable APIs')
  })

  it('references attached PDF when jd_file_uri present', () => {
    const ctx = { ...base, jdFileUri: 'files/abc123' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('see attached PDF')
    expect(prompt).not.toContain('files/abc123')
  })

  it('includes competency section when useQuestionSet true', () => {
    const ctx: InterviewContext = {
      ...base,
      useQuestionSet: true,
      questionSet: {
        id: 'qs-1',
        name: 'SDE',
        role: 'SDE',
        questions: [
          { id: 'q1', text: 'Explain closures in JS', weight: 1 },
        ],
      },
    }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('SUGGESTED COMPETENCY AREAS')
    expect(prompt).toContain('Explain closures')
  })

  it('omits competency section when useQuestionSet false', () => {
    const prompt = buildSystemPromptText(base)
    expect(prompt).not.toContain('SUGGESTED COMPETENCY AREAS')
  })

  it('includes custom instructions when provided', () => {
    const ctx = { ...base, customInstructions: 'Focus on system design' }
    const prompt = buildSystemPromptText(ctx)
    expect(prompt).toContain('Focus on system design')
  })
})
