/**
 * 独立 Fastify 服务入口（Docker / Web 部署专用）
 * 不依赖 Electron，仅提供 UnblockAPI 和 QQMusicAPI
 */
import { serverLog } from "./web-logger";
import { initUnblockAPI } from "./unblock";
import { initQQMusicAPI } from "./qqmusic";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastify from "fastify";

const initStandaloneServer = async () => {
  try {
    const server = fastify({
      routerOptions: {
        // 忽略尾随斜杠
        ignoreTrailingSlash: true,
      },
    });

    // 注册插件
    server.register(fastifyCookie);
    server.register(fastifyMultipart);

    // 声明
    server.get("/api", (_, reply) => {
      reply.send({
        name: "SPlayer Standalone API",
        description: "SPlayer standalone API service for Docker deployment",
        author: "@imsyy",
        list: [
          {
            name: "UnblockAPI",
            url: "/api/unblock",
          },
          {
            name: "QQMusicAPI",
            url: "/api/qqmusic",
          },
        ],
      });
    });

    // 注册接口
    server.register(initUnblockAPI, { prefix: "/api" });
    server.register(initQQMusicAPI, { prefix: "/api" });

    // 监听 25885 端口（避免与 Nginx 的 25884 冲突）
    const port = Number(process.env["STANDALONE_SERVER_PORT"] || 25885);
    await server.listen({ port, host: "127.0.0.1" });
    serverLog.info(`🌐 Starting StandaloneServer on port ${port}`);
    return server;
  } catch (error) {
    serverLog.error("🚫 StandaloneServer failed to start");
    throw error;
  }
};

initStandaloneServer();
