# Playwright's official image ships Chromium AND every system library it needs
# (libnss3, libgbm, libasound, etc.) — which is what makes the "headless login"
# connect method work on hosts (like Render's native runtime) that otherwise
# lack those libs. Keep this tag in sync with the "playwright" version pinned
# in package.json.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Browsers are already baked into the image at /ms-playwright — point Playwright
# at them and skip the (large) postinstall re-download.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Install dependencies first for better layer caching. Includes the
# optionalDependency "playwright" (needed for headless login); browsers are
# not downloaded thanks to the env vars above.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .

# Render provides PORT; the app reads process.env.PORT and defaults to 3000.
EXPOSE 3000
CMD ["node", "server.js"]
