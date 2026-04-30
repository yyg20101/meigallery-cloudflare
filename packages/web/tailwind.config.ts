import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/**/*.{vue,ts,js}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fef7ee',
          100: '#fdeed7',
          200: '#fad9ae',
          300: '#f6be7b',
          400: '#f19a46',
          500: '#ee7d21',
          600: '#df6417',
          700: '#b94b15',
          800: '#933c19',
          900: '#773417',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config
