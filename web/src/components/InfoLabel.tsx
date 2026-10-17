import { Popover, Space } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

/**
 * 带说明图标的标签。点击/悬停信息图标弹出口径解释——
 * 让用户知道这个数是什么、怎么算、有什么口径注意，避免"数字看得见、口径看不懂"。
 */
export default function InfoLabel({ title, help }: { title: ReactNode; help: ReactNode }) {
  return (
    <Space size={4} align="center">
      <span>{title}</span>
      <Popover
        content={<div style={{ maxWidth: 300, fontSize: 13, lineHeight: 1.6 }}>{help}</div>}
        trigger={["hover", "click"]}
        placement="top"
      >
        <InfoCircleOutlined
          style={{ color: "rgba(0,0,0,.30)", cursor: "help", fontSize: 13 }}
          onClick={(e) => e.stopPropagation()}
        />
      </Popover>
    </Space>
  );
}
