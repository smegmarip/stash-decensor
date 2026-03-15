interface ProgressBarProps {
  progress: number
  showLabel?: boolean
}

export function ProgressBar({ progress, showLabel = true }: ProgressBarProps) {
  const percentage = Math.round(progress * 100)

  return (
    <div className="w-full">
      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-300 ease-out"
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <div className="text-xs text-gray-400 mt-1 text-right">
          {percentage}%
        </div>
      )}
    </div>
  )
}
