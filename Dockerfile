FROM node:18-alpine

# Install gh CLI, git, and Go (for ghreport)
RUN apk add --no-cache github-cli git go

# Install ghreport (allow Go to auto-download required toolchain version)
ENV GOTOOLCHAIN=auto
RUN go install github.com/jmainguy/ghreport@latest

# Add Go bin to PATH
ENV PATH="/root/go/bin:${PATH}"

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

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
