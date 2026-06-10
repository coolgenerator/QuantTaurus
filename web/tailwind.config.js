/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0e17',
        panel: '#101626',
        neon: {
          cyan: '#22d3ee',
          purple: '#a78bfa',
          green: '#34d399',
          red: '#fb7185',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(52,211,153,0.7)' },
          '50%': { opacity: '0.7', boxShadow: '0 0 0 6px rgba(52,211,153,0)' },
        },
        'flash-up': {
          '0%': { color: '#34d399', textShadow: '0 0 14px rgba(52,211,153,0.9)' },
          '100%': { color: '#e2e8f0', textShadow: 'none' },
        },
        'flash-down': {
          '0%': { color: '#fb7185', textShadow: '0 0 14px rgba(251,113,133,0.9)' },
          '100%': { color: '#e2e8f0', textShadow: 'none' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
        'flash-up': 'flash-up 0.8s ease-out',
        'flash-down': 'flash-down 0.8s ease-out',
        shimmer: 'shimmer 2.2s linear infinite',
      },
    },
  },
  plugins: [],
}
