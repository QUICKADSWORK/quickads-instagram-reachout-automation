# Apify's official Playwright + Chromium image — browser and all system
# libraries are preinstalled, so the login runs on Apify's servers.
FROM apify/actor-node-playwright-chrome:20

# Install dependencies (browsers are already in the base image).
COPY package*.json ./
RUN npm install --omit=dev --no-optional \
    && echo "Installed npm dependencies:" \
    && (npm list --omit=dev || true)

# Copy the source.
COPY . ./

CMD ["npm", "start", "--silent"]
