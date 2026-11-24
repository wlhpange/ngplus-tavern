"use client";

/**
 * 候选会长卡片（头像 / 简介 / 设定 / 像素小人 / 换人 / 删除）。
 *
 * 从 select.tsx 抽出：卡片是本页最大的一块展示 JSX，状态与请求仍由页面持有，
 * 这里只通过回调上抛动作，保持行为不变。
 */

import Avatar from "@/components/Avatar";
import ChatText from "@/components/ChatText";
import PetDesigner from "@/components/PetDesigner";
import PixelPet from "@/components/PixelPet";
import type { PetDescriptor } from "@/lib/petCatalog";

export interface MasterItem {
  id: string;
  name: string;
  /** 头像 URL（卡 PNG / 上传）；null = 首字兜底 */
  avatar?: string | null;
  /** 像素小人形象参数；null = 未设置 */
  sprite?: PetDescriptor | null;
  selfIntro: string;
  backstory: string;
  tags?: string[];
  isOfficial?: boolean;
  isCustom?: boolean;
}

export interface MasterCardProps {
  m: MasterItem;
  isActive: boolean;
  isFirstPick: boolean;
  switching: string | null;
  deleting: string | null;
  avatarUploading: boolean;
  avatarTarget: string | null;
  spriteEditorFor: string | null;
  spriteDraft: PetDescriptor | null;
  spriteSaving: boolean;
  onChoose: (id: string) => void;
  onPickAvatar: (id: string) => void;
  onClearAvatar: (id: string) => void;
  onToggleSprite: (m: MasterItem) => void;
  onSpriteChange: (d: PetDescriptor) => void;
  onSaveSprite: (id: string) => void;
  onCloseSprite: () => void;
  onRemove: (m: MasterItem) => void;
}

export default function MasterCard({
  m,
  isActive,
  isFirstPick,
  switching,
  deleting,
  avatarUploading,
  avatarTarget,
  spriteEditorFor,
  spriteDraft,
  spriteSaving,
  onChoose,
  onPickAvatar,
  onClearAvatar,
  onToggleSprite,
  onSpriteChange,
  onSaveSprite,
  onCloseSprite,
  onRemove,
}: MasterCardProps) {
  return (
            <article
              key={m.id}
              className={`relative rounded-card border p-4 bg-surface transition-colors duration-200 ${
                isActive
                  ? "border-gold-line"
                  : "border-border hover:border-border-strong"
              }`}
              style={isActive ? { boxShadow: "var(--inset-gold)" } : undefined}
            >
              {isActive && (
                <span className="absolute right-3 top-3 rotate-3 rounded-full border border-gold-line bg-gold-soft px-2 py-0.5 font-numeric text-fs-micro text-gold">
                  现任
                </span>
              )}
              <div className="flex items-center gap-3">
                {/* 头像圆章：现任金淡底金描边，其余 surface-3 底 + 宋体首字；有卡图则直接显示 */}
                <Avatar
                  src={m.avatar}
                  name={m.name}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-lg ${
                    isActive
                      ? "border border-gold-line bg-gold-soft text-gold"
                      : "bg-surface-3 text-fg"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-display text-fs-h3">{m.name}</span>
                  {/* 用 div 包 ChatText：它内部是 div+markdown 的 <p>，套在外层 <p> 里会非法嵌套（hydration 报错） */}
                  <div className="mt-0.5 text-fs-sm leading-relaxed text-fg">
                    <ChatText text={m.selfIntro} />
                  </div>
                </div>
                {m.sprite && <PixelPet descriptor={m.sprite} display={56} className="ml-auto shrink-0" />}
              </div>
              {m.backstory && (
                <div className="mt-2 text-fs-micro leading-relaxed text-muted line-clamp-3">
                  <ChatText text={m.backstory} />
                </div>
              )}
              {!isActive && (
                <button
                  className="mt-3 w-full rounded-btn border border-accent-line py-2 text-fs-sm text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
                  disabled={switching !== null}
                  onClick={() => onChoose(m.id)}
                >
                  {isFirstPick ? `请 ${m.name} 执掌协会` : `换成 ${m.name}`}
                </button>
              )}
              {isActive && (
                <button
                  className="mt-3 w-full rounded-btn border border-gold-line py-2 text-fs-sm text-gold opacity-70"
                  disabled
                >
                  当前会长
                </button>
              )}
              {/* 头像：酒馆式一张图即头像（任何会长都可设置 / 更换 / 清除） */}
              <div className="mt-2 flex items-center justify-center gap-4 text-fs-micro">
                <button
                  type="button"
                  className="text-muted hover:text-fg py-1 transition-colors disabled:opacity-40"
                  disabled={avatarUploading || switching !== null}
                  onClick={() => onPickAvatar(m.id)}
                >
                  {avatarUploading && avatarTarget === m.id
                    ? "正在上传……"
                    : m.avatar
                      ? "更换头像"
                      : "设置头像"}
                </button>
                {m.avatar && (
                  <button
                    type="button"
                    className="text-muted hover:text-danger-text py-1 transition-colors disabled:opacity-40"
                    disabled={avatarUploading || switching !== null}
                    onClick={() => onClearAvatar(m.id)}
                  >
                    清除头像
                  </button>
                )}
              </div>
              {/* 像素小人形象：AI 按卡描述生成过，也可手动改 */}
              <div className="mt-1 flex items-center justify-center">
                <button
                  type="button"
                  className="text-muted hover:text-fg py-1 text-fs-micro transition-colors"
                  onClick={() => onToggleSprite(m)}
                >
                  {m.sprite ? "修改形象" : "生成形象"}
                </button>
              </div>
              {spriteEditorFor === m.id && spriteDraft && (
                <div className="border-border mt-2 space-y-2 border-t pt-3">
                  <PetDesigner
                    value={spriteDraft}
                    onChange={onSpriteChange}
                    display={128}
                    showAnimationSwitch
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="bg-accent text-on-accent rounded-btn flex-1 py-1.5 text-fs-sm font-medium transition-transform active:scale-95 disabled:opacity-40"
                      disabled={spriteSaving}
                      onClick={() => onSaveSprite(m.id)}
                    >
                      {spriteSaving ? "保存中……" : "保存形象"}
                    </button>
                    <button
                      type="button"
                      className="border-border-strong text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-sm transition-colors"
                      onClick={onCloseSprite}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {/* P1：自己请来的会长可删除（归档，不动历史）；官方与在任者不可删 */}
              {!isActive && m.isCustom && (
                <button
                  type="button"
                  className="text-muted hover:text-danger-text mt-2 w-full py-1 text-center text-fs-micro transition-colors disabled:opacity-40"
                  disabled={deleting !== null || switching !== null}
                  onClick={() => onRemove(m)}
                >
                  {deleting === m.id ? "正在归档……" : "删除这位会长"}
                </button>
              )}
            </article>
  );
}
