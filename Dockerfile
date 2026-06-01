# Portable container for the cloud pricing extractor.
# Based on the official Playwright image, which already includes
# Chromium + all the OS libraries it needs (no GPU required).

FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install the JS dependency (browser is already in the base image)
COPY package.json ./
RUN npm install

# App code
COPY server.js ./

# Where results are written (mount a volume here to keep them)
ENV PORT=8080
# ENV ACCESS_CODE=changeme   # uncomment + set to password-protect the UI

EXPOSE 8080
CMD ["node", "server.js"]
