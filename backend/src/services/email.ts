export const emailService = {
  async sendInvite(_params: {
    to: string
    candidateName: string
    jobTitle: string
    token: string
  }): Promise<void> {
    console.log('[Email stub] sendInvite to', _params.to)
  },
}
