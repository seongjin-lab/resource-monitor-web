# 1) 프론트엔드 빌드 → backend/wwwroot
FROM node:22-alpine AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2) 백엔드 게시
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS api
WORKDIR /src/backend
COPY backend/ResourceMonitor.Web.csproj ./
RUN dotnet restore
COPY backend/ ./
COPY --from=web /src/backend/wwwroot ./wwwroot
RUN dotnet publish -c Release -o /app --no-restore

# 3) 실행 이미지
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=api /app ./
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DataDirectory=/data \
    TZ=Asia/Seoul
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "ResourceMonitor.Web.dll"]
