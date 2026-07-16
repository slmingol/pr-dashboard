FROM node:18-alpine

# Install gh CLI, git, and Go (for ghreport)
RUN apk add --no-cache github-cli git go

# Install ghreport — clone and build directly because the fork's go.mod still
# declares the upstream module path, which go install rejects as a path mismatch
ENV GOTOOLCHAIN=auto
RUN git clone --depth=1 https://github.com/slmingol/ghreport /tmp/ghreport \
    && cd /tmp/ghreport \
    && go build -o /usr/local/bin/ghreport . \
    && rm -rf /tmp/ghreport


WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY server.js ./
COPY public ./public

# Create data directory for ghreport output
RUN mkdir -p /data

# Bake build version — placed after COPY so file changes bust cache independently
ARG BUILD_VERSION=dev
ENV APP_VERSION=$BUILD_VERSION

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
