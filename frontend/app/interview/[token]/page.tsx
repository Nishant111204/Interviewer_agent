import { InterviewPage } from './InterviewPage'

interface Props {
  params: { token: string }
}

export default function Page({ params }: Props) {
  return <InterviewPage token={params.token} />
}
