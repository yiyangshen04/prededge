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
      className={`h-9 px-4 rounded-lg text-sm font-medium transition-all ${
        loading
          ? "bg-bg-card border border-border text-text-muted cursor-not-allowed"
          : "bg-accent-blue text-white shadow-sm hover:brightness-110 active:scale-[0.98]"
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
