# FreightStream —— 本地开发与测试入口
# 连接串统一从 documents/analytics-db.connection.yaml 读，不需要环境变量

.PHONY: install dev start stop status build preview typecheck refresh help

help:
	@echo "  make install    安装 api/ 与 web/ 的依赖"
	@echo "  make dev        开发模式：API(8787) + 前端热更新(5173)，Ctrl-C 一起停"
	@echo "  make preview    部署前测试：生产构建 + 本地 API，访问 http://localhost:4173"
	@echo "  make build      只构建 web/dist 与 api/dist"
	@echo "  make typecheck  两端类型检查"
	@echo "  make refresh    从 MSSQL 全量刷新镜像并重建物化视图"
	@echo "  make start      后台常驻启动（关掉终端也不停）→ http://localhost:4173"
	@echo "  make stop       停止后台服务"
	@echo "  make status     查看运行状态"

install:
	cd api && npm install
	cd web && npm install

dev:
	@trap 'kill 0' INT TERM; \
	(cd api && npm run dev) & \
	(cd web && npm run dev) & \
	wait

build:
	cd web && npm run build
	cd api && npm run build

preview: build
	@echo "→ http://localhost:4173   （生产构建 + 本地 API，Ctrl-C 停止）"
	@trap 'kill 0' INT TERM; \
	(cd api && npm start) & \
	(cd web && npx vite preview --port 4173 --strictPort) & \
	wait

typecheck:
	cd api && npm run typecheck
	cd web && npm run typecheck

refresh:
	. .venv/bin/activate && python etl/refresh_mirror.py --verify
	@PGPASSWORD=$$(grep 'fs_app *LOGIN PASSWORD' documents/sql-originals/001_bootstrap.sql | sed "s/.*'\(.*\)'.*/\1/") \
	  /usr/local/opt/libpq/bin/psql -h localhost -U fs_app -d freightstream -c "SELECT * FROM mart.refresh_all();"

start:
	@bash scripts/start.sh

stop:
	@bash scripts/stop.sh

status:
	@bash scripts/status.sh
