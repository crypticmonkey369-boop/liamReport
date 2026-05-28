# Use lightweight alpine Node.js 18 base image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency configs first (takes advantage of Docker layer caching)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application files (public assets, code files, and config templates)
COPY public ./public
COPY src ./src
COPY server.js ./

# Expose default HTTP server port
EXPOSE 3000

# Set Node environment to production
ENV NODE_ENV=production

# Start the Express server and scheduler background process
CMD ["node", "server.js"]
