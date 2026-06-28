# Universal container image (works on Railway, Fly.io, Render, or any host).
FROM node:20-slim

WORKDIR /app
COPY . .

# The converted map assets are already committed under client/public/maps,
# so the build doesn't need the local-only asset pipeline tools.
RUN npm install && npm run build

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
