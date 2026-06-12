import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const transformIndexHtmlPlugin = () => {
  return {
    name: 'html-transform',
    async transformIndexHtml(html: string) {
      const {
        getComponentChunkLinks,
        getFontFaceStyles,
        getFontLinks,
        getIconLinks,
        getInitialStyles,
        getMetaTagsAndIconLinks,
      } = await import('@porsche-design-system/components-react/partials');

      const headPartials = [
        getInitialStyles(),
        getFontFaceStyles(),
        getFontLinks({ weights: ['regular', 'semi-bold', 'bold'] }),
        getComponentChunkLinks(),
        getIconLinks(),
        getMetaTagsAndIconLinks({ appTitle: 'Porsche Design System' }),
      ].join('');

      return html.replace(/<\/head>/, `${headPartials}</head>`);
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), transformIndexHtmlPlugin()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
});
