"use client";

export function ScanButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        loading
          ? "bg-bg-card text-text-muted cursor-not-allowed"
          : "bg-accent-blue text-white hover:bg-accent-blue/80"
      }`}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <svg
            className="animate-spin h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Scanning...
        </span>
      ) : (
        "Run Scan"
      )}
    </button>
  );
}
