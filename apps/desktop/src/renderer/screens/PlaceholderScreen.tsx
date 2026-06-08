interface Props {
  title: string
  phase: string
}

export function PlaceholderScreen({ title, phase }: Props): JSX.Element {
  return (
    <div className="screen">
      <h1>{title}</h1>
      <div className="card muted">
        <p>This screen is part of the build plan and will be implemented in {phase}.</p>
        <p>See <code>docs/IMPLEMENTATION_PLAN.md</code> for the roadmap.</p>
      </div>
    </div>
  )
}
