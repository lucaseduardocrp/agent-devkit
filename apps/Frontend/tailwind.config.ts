import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
          accent: 'var(--border-accent)',
          success: 'var(--border-success)',
        },
        primary: {
          DEFAULT: 'var(--fill-accent)',
          hover: 'var(--fill-accent-hover)',
          foreground: 'var(--on-accent)',
        },
        muted: {
          DEFAULT: 'var(--text-muted)',
          foreground: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--fill-accent)',
          foreground: 'var(--text-accent)',
        },
        success: {
          DEFAULT: 'var(--fill-success)',
          foreground: 'var(--text-success)',
        },
        warning: {
          DEFAULT: 'var(--fill-warning)',
          foreground: 'var(--text-warning)',
        },
        danger: {
          DEFAULT: 'var(--fill-danger)',
          foreground: 'var(--text-danger)',
        },
        pro: {
          DEFAULT: 'var(--fill-pro)',
          foreground: 'var(--text-pro)',
        },
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
