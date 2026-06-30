import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const BASE_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000'
const FROM = 'InterviewAI <onboarding@resend.dev>'

export const emailService = {
  async sendInvite({
    to,
    candidateName,
    jobTitle,
    token,
  }: {
    to: string
    candidateName: string
    jobTitle: string
    token: string
  }): Promise<void> {
    const link = `${BASE_URL}/interview/${token}`
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Your interview for ${jobTitle} at Wohlig`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #1e293b;">Hi ${candidateName},</h2>
          <p>You have been invited to complete an AI-powered interview for the <strong>${jobTitle}</strong> position at Wohlig Transformations.</p>
          <p>Click the button below to start your interview. The link is valid for 48 hours.</p>
          <a href="${link}" style="display: inline-block; margin: 24px 0; padding: 12px 28px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Start Interview
          </a>
          <p style="color: #64748b; font-size: 14px;">
            <strong>Before you begin:</strong><br />
            &bull; Use Google Chrome for the best experience<br />
            &bull; Find a quiet, well-lit location<br />
            &bull; Allow camera and microphone access when prompted<br />
            &bull; The interview takes approximately 45 minutes
          </p>
          <p style="color: #94a3b8; font-size: 12px;">
            If the button does not work, copy this link into Chrome:<br />
            <a href="${link}" style="color: #3b82f6;">${link}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="color: #94a3b8; font-size: 12px;">This is an automated message from InterviewAI by Wohlig Transformations. Do not reply to this email.</p>
        </div>
      `,
    })
  },
}
