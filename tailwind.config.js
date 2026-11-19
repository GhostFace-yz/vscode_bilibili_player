/** @type {import('tailwindcss').Config} */
module.exports = {
  prefix: 'bp-',
  important: '#bili-skin-hud',
  corePlugins: {
    // 绝不能让 Tailwind 的 preflight 重置 VS Code 工作台样式
    preflight: false,
  },
  content: ['./src/skin/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bili: '#fb7299',
      },
    },
  },
  plugins: [],
};
