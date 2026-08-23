import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0b0d0e',
        panel: '#121617',
        elevated: '#191e1f',
        line: '#2a3233',
        ink: '#edf3f1',
        muted: '#91a09d',
        mint: '#8de0bc',
        amber: '#f2bd72',
        coral: '#ed8e83',
        cyan: '#7dc6dc',
      },
      boxShadow: {
        panel: '0 12px 30px rgba(0, 0, 0, 0.22)',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
