FROM node:20-alpine

# Install curl for health check
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/

EXPOSE ${API_PORT:-8080}

CMD ["node", "src/index.js"]
