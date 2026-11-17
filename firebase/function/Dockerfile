# HSK Parcel Tracker - live status function.
# Cloud Run builds this on every push to main, so nobody has to paste code again.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

# Cloud Run injects PORT; functions-framework picks it up.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
