// Radio chatter system — in-game dialogue for allies and enemies.
//
// ARCHITECTURE (per user request: IndexTTS 中文配音 + 整句播完队列):
//   Each line has a Chinese subtitle (`text`) which the HUD shows, and a
//   pre-recorded Chinese voice file at /audio/radio/<event>-<idx>.mp3
//   (generated offline with IndexTTS2.5; see scripts/export-radio-voices.ts).
//   The old Web Speech API (speechSynthesis) English synthesis has been
//   removed — speechSynthesis.cancel() used to cut an in-flight line short,
//   which is exactly the "两句同时到时后一句挤掉前一句" bug.
//
//   Playback is now SINGLE-FLIGHT: at most one voice line is audible at a
//   time, and a line is never interrupted once it starts. When several
//   messages are due at once they drain in priority order
//   (剧情 story > 告警 alert > 常规 normal) — the currently speaking line
//   always finishes first; the next one only starts after it has completed
//   plus a short inter-line gap.
//
// Subtitles are locale-aware: when the UI locale is 'en' the line's `en`
// translation is shown, otherwise the Chinese script line (see lineText()).
//
// The engine calls `trigger(event)` for gameplay events. The system picks an
// appropriate line from a pool (with anti-repetition), enqueues it, and the
// HUD reads `update()` each frame to render subtitles.
import { AudioEngine } from './audio';
import type { Speaker } from './audio';
import { getLocale } from './i18n';
export type RadioSide = 'ally' | 'enemy' | 'awacs';
export type RadioCategory = 'story' | 'alert' | 'normal';
export interface RadioMessage {
  id: number;
  speaker: string;        // callsign shown in the HUD subtitle
  side: RadioSide;
  text: string;           // Chinese subtitle (also the speech the audio says)
  category: RadioCategory;
  voiceFile: string;      // /audio/radio/<event>-<idx>.mp3
  duration: number;       // subtitle stay time (sec) once it starts
  startAt: number;        // wall seconds — earliest this line may begin
  voiceSpeaker: Speaker;  // which recorded voice profile this line uses
  // --- single-flight runtime state ---
  started: boolean;       // audio/subtitle actually began
  endAt: number;          // wall seconds when the subtitle window closes (0 = still playing)
}
export type RadioEvent =
  | 'mission_start'
  | 'target_acquired'
  | 'missile_launch'
  | 'enemy_missile_launch'
  | 'kill_fighter'
  | 'kill_bomber'
  | 'multi_kill'
  | 'ally_down'
  | 'player_hit'
  | 'missile_warning'
  | 'low_hp'
  | 'stall_warning'
  | 'mission_complete'
  | 'mission_failed'
  | 'no_target'
  | 'weapon_empty'
  | 'engage'
  | 'disengage'
  | 'taunt'
  | 'bogey_dopple'
  | 'wingman_attack'
  | 'wingman_cover'
  | 'wingman_form'
  | 'wingman_kill'
  | 'wingman_hit'
  | 'weather_warning'
  | 'missile_miss'
  | 'splash_call'
  | 'story_t00_intro'
  | 'story_t00_engage'
  | 'story_t00_laser1'
  | 'story_t00_laser3'
  | 'story_t00_laser5'
  | 'story_t00_radar_down'
  | 'story_t00_ace_enter'
  | 'story_t00_ace_engage'
  | 'story_t00_ace_strain'
  | 'story_t00_ace_kill1'
  | 'story_t00_ace_kill5'
  | 'story_t00_end'
  | 'story_s01_s0_awacs_01'
  | 'story_s01_s0_escort_01'
  | 'story_s01_s0_escort_02'
  | 'story_s01_s0_escort_03'
  | 'story_s01_s0_escort_04'
  | 'story_s01_s0_escort_05'
  | 'story_s01_s0_escort_06'
  | 'story_s01_s0_escort_07'
  | 'story_s01_s0_escort_08'
  | 'story_s01_s0_escort_09'
  | 'story_s01_s0_escort_10'
  | 'story_s01_s1_open_01'
  | 'story_s01_s1_open_02'
  | 'story_s01_s1_open_03'
  | 'story_s01_s1_open_04'
  | 'story_s01_s1_open_05'
  | 'story_s01_s1_mount_01'
  | 'story_s01_s1_mount_02'
  | 'story_s01_s1_mount_03'
  | 'story_s01_s1_mount_04'
  | 'story_s01_s1_mount_05'
  | 'story_s01_s1_loss_01'
  | 'story_s01_s1_loss_02'
  | 'story_s01_s1_loss_03'
  | 'story_s01_s1_loss_04'
  | 'story_s01_s1_mount2_01'
  | 'story_s01_s1_mount2_02'
  | 'story_s01_s1_mount2_03'
  | 'story_s01_s1_mount2_04'
  | 'story_s01_s1_mount2_05'
  | 'story_s01_s1_mount2_06'
  | 'story_s01_s1_mount2_07'
  | 'story_s01_s1_mount2_08'
  | 'story_s01_s1_mount2_09'
  | 'story_s01_s1_mount2_10'
  | 'story_s01_s2_trigger_01'
  | 'story_s01_s2_open_01'
  | 'story_s01_s2_open_02'
  | 'story_s01_s2_open_03'
  | 'story_s01_s2_open_04'
  | 'story_s01_s2_open_05'
  | 'story_s01_s2_open_06'
  | 'story_s01_s2_open_07'
  | 'story_s01_s2_mount_01'
  | 'story_s01_s2_mount_02'
  | 'story_s01_s2_mount_03'
  | 'story_s01_s2_mount_04'
  | 'story_s01_s2_mount_05'
  | 'story_s01_s2_mount_06'
  | 'story_s01_s2_mount_07'
  | 'story_s01_s2_loss_01'
  | 'story_s01_s2_loss_02'
  | 'story_s01_s2_loss_03'
  | 'story_s01_s2_loss_04'
  | 'story_s01_s2_mount2_01'
  | 'story_s01_s2_mount2_02'
  | 'story_s01_s2_mount2_03'
  | 'story_s01_s2_mount2_04'
  | 'story_s01_s2_mount2_05'
  | 'story_s01_s2_mount2_06'
  | 'story_s01_s2_mount2_07'
  | 'story_s01_s2_mount2_08'
  | 'story_s01_s3_trigger_01'
  | 'story_s01_s3_open_01'
  | 'story_s01_s3_open_02'
  | 'story_s01_s3_open_03'
  | 'story_s01_s3_open_04'
  | 'story_s01_s3_open_05'
  | 'story_s01_s3_open_06'
  | 'story_s01_s3_open_07'
  | 'story_s01_s3_open_08'
  | 'story_s01_s3_mount_01'
  | 'story_s01_s3_mount_02'
  | 'story_s01_s3_mount_03'
  | 'story_s01_s3_mount_04'
  | 'story_s01_s3_mount_05'
  | 'story_s01_s3_mount_06'
  | 'story_s01_s3_mount_07'
  | 'story_s01_s3_mount_08'
  | 'story_s01_s3_anvil_01'
  | 'story_s01_s3_anvil_02'
  | 'story_s01_s3_anvil_03'
  | 'story_s01_s3_anvil_04'
  | 'story_s01_s3_anvil_05'
  | 'story_s01_s3_anvil_06'
  | 'story_s01_s3_mount2_01'
  | 'story_s01_s3_mount2_02'
  | 'story_s01_s3_mount2_03'
  | 'story_s01_s3_mount2_04'
  | 'story_s01_s3_mount2_05'
  | 'story_s01_s3_mount2_06'
  | 'story_s01_s3_mount2_07'
  | 'story_s01_s3_mount2_08'
  | 'story_s01_s3_mount2_09'
  | 'story_s01_s3_mount2_10'
  | 'story_s01_s3_mount2_11'
  | 'story_s01_s4_open_01'
  | 'story_s01_s4_open_02'
  | 'story_s01_s4_open_03'
  | 'story_s01_s4_open_04'
  | 'story_s01_s4_open_05'
  | 'story_s01_s4_open_06'
  | 'story_s01_s4_open_07'
  | 'story_s01_s4_open_08'
  | 'story_s01_s4_loss_01'
  | 'story_s01_s4_loss_02'
  | 'story_s01_s4_loss_03'
  | 'story_s01_s4_loss_04'
  | 'story_s01_s4_core_01'
  | 'story_s01_s4_core_02'
  | 'story_s01_s4_core_03'
  | 'story_s01_s4_core_04'
  | 'story_s01_s4_core_05'
  | 'story_s01_s4_core_06'
  | 'story_s01_s4_core_07'
  | 'story_s01_s4_core_08'
  | 'story_s01_s4_core_09'
  | 'story_s01_s4_core_10'
  | 'story_s01_s4_core2_01'
  | 'story_s01_s4_core2_02'
  | 'story_s01_s4_core2_03'
  | 'story_s01_s4_core2_04'
  | 'story_s01_s5_fall_01'
  | 'story_s01_s5_fall_02'
  | 'story_s01_s5_fall_03'
  | 'story_s01_s5_fall_04'
  | 'story_s01_s5_fall_05'
  | 'story_s01_s5_fall_06'
  | 'story_s01_s5_fall_07'
  | 'story_s01_ally_s0_open_01'
  | 'story_s01_ally_s0_open_02'
  | 'story_s01_ally_s0_open_03'
  | 'story_s01_ally_s0_open_04'
  | 'story_s01_ally_s0_open_05'
  | 'story_s01_ally_s0_open_06'
  | 'story_s01_ally_s0_open_07'
  | 'story_s01_ally_s0_open_08'
  | 'story_s01_ally_s0_open_09'
  | 'story_s01_ally_s0_open_10'
  | 'story_s01_ally_s0_open_11'
  | 'story_s01_ally_s1_open_01'
  | 'story_s01_ally_s1_open_02'
  | 'story_s01_ally_s1_open_03'
  | 'story_s01_ally_s1_open_04'
  | 'story_s01_ally_s1_open_05'
  | 'story_s01_ally_s1_open_06'
  | 'story_s01_ally_s1_open_07'
  | 'story_s01_ally_s1_open_08'
  | 'story_s01_ally_s1_open_09'
  | 'story_s01_ally_s1_open_10'
  | 'story_s01_ally_s1_first_01'
  | 'story_s01_ally_s1_first_02'
  | 'story_s01_ally_s1_first_03'
  | 'story_s01_ally_s1_first_04'
  | 'story_s01_ally_s1_first_05'
  | 'story_s01_ally_s1_half_01'
  | 'story_s01_ally_s1_half_02'
  | 'story_s01_ally_s1_half_03'
  | 'story_s01_ally_s1_half_04'
  | 'story_s01_ally_s1_half_05'
  | 'story_s01_ally_s1_half_06'
  | 'story_s01_ally_s1_last_01'
  | 'story_s01_ally_s1_last_02'
  | 'story_s01_ally_s1_last_03'
  | 'story_s01_ally_s1_last_04'
  | 'story_s01_ally_s1_last_05'
  | 'story_s01_ally_s2_open_01'
  | 'story_s01_ally_s2_open_02'
  | 'story_s01_ally_s2_open_03'
  | 'story_s01_ally_s2_open_04'
  | 'story_s01_ally_s2_open_05'
  | 'story_s01_ally_s2_open_06'
  | 'story_s01_ally_s2_open_07'
  | 'story_s01_ally_s2_open_08'
  | 'story_s01_ally_s2_open_09'
  | 'story_s01_ally_s2_half_01'
  | 'story_s01_ally_s2_half_02'
  | 'story_s01_ally_s2_half_03'
  | 'story_s01_ally_s2_half_04'
  | 'story_s01_ally_s2_half_05'
  | 'story_s01_ally_s2_half_06'
  | 'story_s01_ally_s2_last_01'
  | 'story_s01_ally_s2_last_02'
  | 'story_s01_ally_s2_last_03'
  | 'story_s01_ally_s2_last_04'
  | 'story_s01_ally_s2_last_05'
  | 'story_s01_ally_s3_open_01'
  | 'story_s01_ally_s3_open_02'
  | 'story_s01_ally_s3_open_03'
  | 'story_s01_ally_s3_open_04'
  | 'story_s01_ally_s3_open_05'
  | 'story_s01_ally_s3_open_06'
  | 'story_s01_ally_s3_open_07'
  | 'story_s01_ally_s3_open_08'
  | 'story_s01_ally_s3_open_09'
  | 'story_s01_ally_s3_open_10'
  | 'story_s01_ally_s3_charge_01'
  | 'story_s01_ally_s3_charge_02'
  | 'story_s01_ally_s3_charge_03'
  | 'story_s01_ally_s3_charge_04'
  | 'story_s01_ally_s3_laser1_01'
  | 'story_s01_ally_s3_laser1_02'
  | 'story_s01_ally_s3_laser1_03'
  | 'story_s01_ally_s3_anvil1_01'
  | 'story_s01_ally_s3_anvil1_02'
  | 'story_s01_ally_s3_anvil1_03'
  | 'story_s01_ally_s3_anvil1_04'
  | 'story_s01_ally_s3_anvil2_01'
  | 'story_s01_ally_s3_anvil2_02'
  | 'story_s01_ally_s3_anvil2_03'
  | 'story_s01_ally_s3_lasers_clear_01'
  | 'story_s01_ally_s3_lasers_clear_02'
  | 'story_s01_ally_s3_lasers_clear_03'
  | 'story_s01_ally_s3_lasers_clear_04'
  | 'story_s01_ally_s3_lasers_clear_05'
  | 'story_s01_ally_s4_open_01'
  | 'story_s01_ally_s4_open_02'
  | 'story_s01_ally_s4_open_03'
  | 'story_s01_ally_s4_open_04'
  | 'story_s01_ally_s4_open_05'
  | 'story_s01_ally_s4_open_06'
  | 'story_s01_ally_s4_open_07'
  | 'story_s01_ally_s4_open_08'
  | 'story_s01_ally_s4_open_09'
  | 'story_s01_ally_s4_core1_01'
  | 'story_s01_ally_s4_core1_02'
  | 'story_s01_ally_s4_core1_03'
  | 'story_s01_ally_s4_core1_04'
  | 'story_s01_ally_s4_core2_01'
  | 'story_s01_ally_s4_core2_02'
  | 'story_s01_ally_s4_core2_03'
  | 'story_s01_ally_s4_core3_01'
  | 'story_s01_ally_s4_core3_02'
  | 'story_s01_ally_s4_core3_03'
  | 'story_s01_ally_s4_core4_01'
  | 'story_s01_ally_s4_core4_02'
  | 'story_s01_ally_s4_core4_03'
  | 'story_s01_ally_s4_core4_04'
  | 'story_s01_ally_s4_core4_05'
  | 'story_s01_ally_s4_core4_06'
  | 'story_s01_ally_s4_core4_07'
  | 'story_s01_ally_s4_core4_08'
  | 'story_s01_ally_s5_fall_01'
  | 'story_s01_ally_s5_fall_02'
  | 'story_s01_ally_s5_fall_03'
  | 'story_s01_ally_s5_fall_04'
  | 'story_s01_ally_s5_fall_05'
  | 'story_s01_ally_s5_fall_06'
  | 'story_s01_rand_control'
  | 'story_s02_s0_open_01'
  | 'story_s02_s0_open_02'
  | 'story_s02_s0_open_03'
  | 'story_s02_s0_open_04'
  | 'story_s02_s0_open_05'
  | 'story_s02_s0_open_06'
  | 'story_s02_s0_open_07'
  | 'story_s02_s0_open_08'
  | 'story_s02_s0_open_09'
  | 'story_s02_s0_open_10'
  | 'story_s02_s0_open_11'
  | 'story_s02_s1_open_09'
  | 'story_s02_s1_open_10'
  | 'story_s02_s1_open_11'
  | 'story_s02_s1_open_12'
  | 'story_s02_s2_open_06'
  | 'story_s02_s2_open_07'
  | 'story_s02_s2_open_08'
  | 'story_s02_s2_open_09'
  | 'story_s02_s2_open_10'
  | 'story_s02_s2_open_11'
  | 'story_s02_s2_open_13'
  | 'story_s02_s3_open_05'
  | 'story_s02_s3_open_06'
  | 'story_s02_s3_open_07'
  | 'story_s02_s3_open_08'
  | 'story_s02_s3_open_09'
  | 'story_s02_s3_open_10'
  | 'story_s02_s3_open_11'
  | 'story_s02_s3_open_12'
  | 'story_s02_s3_open_13'
  | 'story_s02_s3_open_14'
  | 'story_s02_s3_open_15'
  | 'story_s02_s4_open_01'
  | 'story_s02_s4_open_02'
  | 'story_s02_s4_open_03'
  | 'story_s02_s4_open_04'
  | 'story_s02_s4_open_05'
  | 'story_s02_s4_open_06'
  | 'story_s02_s4_open_07'
  | 'story_s02_s4_open_08'
  | 'story_s02_s4_open_09'
  | 'story_s02_s4_open_10'
  | 'story_s02_s4_open_11'
  | 'story_s02_s4_open_12'
  | 'story_s02_s4_open_13'
  | 'story_s02_s4_open_14'
  | 'story_s02_s4_open_15'
  | 'story_s02_s4_open_16'
  | 'story_s02_s4_open_17'
  | 'story_s02_s4_open_18'
  | 'story_s02_s4_open_19'
  | 'story_s02_s4_open_20'
  | 'story_s02_s5_open_01'
  | 'story_s02_s5_open_02'
  | 'story_s02_s5_open_03'
  | 'story_s02_s5_open_04'
  | 'story_s02_s5_open_05'
  | 'story_s02_s5_open_06'
  | 'story_s02_s5_open_07'
  | 'story_s02_s5_open_08'
  | 'story_s02_s6_open_01'
  | 'story_s02_s6_open_02'
  | 'story_s02_s6_open_03'
  | 'story_s02_s6_open_04'
  | 'story_s02_s6_open_05'
  | 'story_s02_s6_open_06'
  | 'story_s02_s6_open_17'
  | 'story_s02_s7_base_01'
  | 'story_s02_s7_base_02'
  | 'story_s02_s7_base_03'
  | 'story_s02_s7_base_04'
  | 'story_s02_s7_base_05'
  | 'story_s02_s7_base_06'
  | 'story_s02_s0_open_12'
  | 'story_s02_s0_open_13'
  | 'story_s02_s0_open_14'
  | 'story_s02_s0_open_15'
  | 'story_s02_s0_open_16'
  | 'story_s02_s0_open_17'
  | 'story_s02_s0_open_18'
  | 'story_s02_s1_open_13'
  | 'story_s02_s1_open_14'
  | 'story_s02_s1_open_15'
  | 'story_s02_s1_open_16'
  | 'story_s02_s2_open_19'
  | 'story_s02_s2_open_20'
  | 'story_s02_s2_open_21'
  | 'story_s02_s2_open_22'
  | 'story_s02_s2_open_23'
  | 'story_s02_s2_open_24'
  | 'story_s02_s2_open_25'
  | 'story_s02_s2_open_26'
  | 'story_s02_s2_open_27'
  | 'story_s02_s2_open_28'
  | 'story_s02_s2_open_29'
  | 'story_s02_s2_open_30'
  | 'story_s02_s2_open_31'
  | 'story_s02_s2_open_32'
  | 'story_s02_s3_open_16'
  | 'story_s02_s3_open_17'
  | 'story_s02_s3_open_18'
  | 'story_s02_s3_open_19'
  | 'story_s02_s3_open_20'
  | 'story_s02_s3_open_21'
  | 'story_s02_s3_open_22'
  | 'story_s02_s3_open_23'
  | 'story_s02_s4_open_21'
  | 'story_s02_s4_open_22'
  | 'story_s02_s4_open_23'
  | 'story_s02_s4_open_24'
  | 'story_s02_s4_open_25'
  | 'story_s02_s4_open_26'
  | 'story_s02_s4_open_27'
  | 'story_s02_s4_open_28'
  | 'story_s02_s4_open_29'
  | 'story_s02_s4_open_30'
  | 'story_s02_s4_open_31'
  | 'story_s02_s4_open_32'
  | 'story_s02_s4_open_33'
  | 'story_s02_s4_open_34'
  | 'story_s01_brief_01'
  | 'story_s01_brief_04'
  | 'story_s01_brief_07'
  | 'story_s01_brief_10'
  | 'story_s01_brief_13'
  | 'story_s01_brief_16'
  | 'story_s01_debrief_01'
  | 'story_s01_debrief_03'
  | 'story_s01_rand_control'
  | 'story_s02_s7_base_06'
  | 'story_s01_brief_02'
  | 'story_s01_brief_03'
  | 'story_s01_brief_05'
  | 'story_s01_brief_06'
  | 'story_s01_brief_08'
  | 'story_s01_brief_09'
  | 'story_s01_brief_11'
  | 'story_s01_brief_12'
  | 'story_s01_brief_14'
  | 'story_s01_brief_15'
  | 'story_s01_brief_17'
  | 'story_s01_brief_18'
  | 'story_s01_debrief_02'
  | 'story_s01_debrief_04'
  | 'story_s01_cine_intro_01'
  | 'story_s01_cine_intro_02'
  | 'story_s01_cine_intro_03'
  | 'story_s01_cine_intro_04'
  | 'story_s01_cine_intro_05'
  | 'story_s01_cine_intro_06'
  | 'story_s01_cine_crash_01'
  | 'story_s01_cine_crash_02'
  | 'story_s01_cine_crash_03'
  | 'story_s01_cine_crash_04'
  | 'story_s02_s1_open_01'
  | 'story_s02_s1_open_02'
  | 'story_s02_s1_open_03'
  | 'story_s02_s1_open_04'
  | 'story_s02_s1_open_05'
  | 'story_s02_s1_open_06'
  | 'story_s02_s1_open_07'
  | 'story_s02_s1_open_08'
  | 'story_s02_s2_open_01'
  | 'story_s02_s2_open_02'
  | 'story_s02_s2_open_03'
  | 'story_s02_s2_open_04'
  | 'story_s02_s2_open_05'
  | 'story_s02_s2_open_12'
  | 'story_s02_s2_open_14'
  | 'story_s02_s2_open_15'
  | 'story_s02_s2_open_16'
  | 'story_s02_s2_open_17'
  | 'story_s02_s2_open_18'
  | 'story_s02_s3_open_01'
  | 'story_s02_s3_open_02'
  | 'story_s02_s3_open_03'
  | 'story_s02_s3_open_04'
  | 'story_s02_s3_open_24'
  | 'story_s02_s3_open_25'
  | 'story_s02_s3_open_26'
  | 'story_s02_s3_open_27'
  | 'story_s02_s3_open_28'
  | 'story_s02_s3_open_29'
  | 'story_s02_s3_open_30'
  | 'story_s02_s3_open_31'
  | 'story_s02_s4_open_35'
  | 'story_s02_s4_open_36'
  | 'story_s02_s5_open_09'
  | 'story_s02_s5_open_10'
  | 'story_s02_s5_open_11'
  | 'story_s02_s5_open_12'
  | 'story_s02_s5_open_13'
  | 'story_s02_s5_open_14'
  | 'story_s02_s5_open_15'
  | 'story_s02_s5_open_16'
  | 'story_s02_s5_open_17'
  | 'story_s02_s5_open_18'
  | 'story_s02_s5_open_19'
  | 'story_s02_s5_open_20'
  | 'story_s02_s5_open_21'
  | 'story_s02_s5_open_22'
  | 'story_s02_s5_open_23'
  | 'story_s02_s5_open_24'
  | 'story_s02_s5_open_25'
  | 'story_s02_s5_open_26'
  | 'story_s02_s5_open_27'
  | 'story_s02_s5_open_28'
  | 'story_s02_s5_open_29'
  | 'story_s02_s5_open_30'
  | 'story_s02_s5_open_31'
  | 'story_s02_s5_open_32'
  | 'story_s02_s5_open_33'
  | 'story_s02_s5_open_34'
  | 'story_s02_s5_open_35'
  | 'story_s02_s5_open_36'
  | 'story_s02_s5_open_37'
  | 'story_s02_s5_open_38'
  | 'story_s02_s5_open_39'
  | 'story_s02_s5_open_40'
  | 'story_s02_s5_open_41'
  | 'story_s02_s5_open_42'
  | 'story_s02_s5_open_43'
  | 'story_s02_s5_open_44'
  | 'story_s02_s5_open_45'
  | 'story_s02_s5_open_46'
  | 'story_s02_s5_open_47'
  | 'story_s02_s5_open_48'
  | 'story_s02_s5_open_49'
  | 'story_s02_s5_open_50'
  | 'story_s02_s5_open_51'
  | 'story_s02_s5_open_52'
  | 'story_s02_s5_open_53'
  | 'story_s02_s5_open_54'
  | 'story_s02_s5_open_55'
  | 'story_s02_s5_open_56'
  | 'story_s02_s5_open_57'
  | 'story_s02_s5_open_58'
  | 'story_s02_s5_open_59'
  | 'story_s02_s5_open_60'
  | 'story_s02_s5_open_61'
  | 'story_s02_s5_open_62'
  | 'story_s02_s5_open_63'
  | 'story_s02_s5_open_64'
  | 'story_s02_s5_open_65'
  | 'story_s02_s5_open_66'
  | 'story_s02_s5_open_67'
  | 'story_s02_s5_open_68'
  | 'story_s02_s5_open_69'
  | 'story_s02_s5_open_70'
  | 'story_s02_s5_open_71'
  | 'story_s02_s6_open_07'
  | 'story_s02_s6_open_08'
  | 'story_s02_s6_open_09'
  | 'story_s02_s6_open_10'
  | 'story_s02_s6_open_11'
  | 'story_s02_s6_open_12'
  | 'story_s02_s6_open_13'
  | 'story_s02_s6_open_14'
  | 'story_s02_s6_open_15'
  | 'story_s02_s6_open_16'
  | 'story_s02_s6_open_18'
  | 'story_s02_s6_open_19'
  | 'story_s02_s6_open_20'
  | 'story_s02_s6_open_21'
  | 'story_s02_s6_open_22'
  | 'story_s02_s6_open_23'
  | 'story_s02_s6_open_24'
  | 'story_s02_s6_open_25'
  | 'story_s02_s6_open_26'
  | 'story_s02_s6_open_27'
  | 'story_s02_s6_open_28'
  | 'story_s02_s6_open_29'
  | 'story_s02_s6_open_30'
  | 'story_s02_s6_open_31'
  | 'story_s02_s7_base_07'
  | 'story_s02_s7_base_08'
  | 'story_s02_s7_base_09'
  | 'story_s02_s7_base_10'
  | 'story_s02_s7_base_11'
  | 'story_s02_s7_base_12'
  | 'story_s02_s7_base_13'
  | 'story_s02_s7_base_14'
  | 'story_s02_s7_base_15'
  | 'story_s02_s7_base_16'
  | 'story_s02_s7_base_17'
  | 'story_s02_s7_base_18'
  | 'story_s02_s8_hangar_01'
  | 'story_s02_s8_hangar_02'
  | 'story_s02_s8_hangar_03'
  | 'story_s02_s8_hangar_04'
  | 'story_s02_s8_hangar_05'
  | 'story_s02_s8_hangar_06'
  | 'story_s02_s8_hangar_07'
  | 'story_s02_s8_hangar_08'
  | 'story_s02_s8_hangar_09'
  | 'story_s02_s8_hangar_10'
  | 'story_s02_brief_01'
  | 'story_s02_brief_02'
  | 'story_s02_brief_03'
  | 'story_s02_brief_04'
  | 'story_s02_brief_05'
  | 'story_s02_brief_06'
  | 'story_s02_brief_07'
  | 'story_s02_brief_08'
  | 'story_s02_brief_09'
  | 'story_s02_brief_10'
  | 'story_s02_brief_11'
  | 'story_s02_brief_12'
  | 'story_s02_brief_13'
  | 'story_s02_brief_14'
  | 'story_s02_brief_15'
  | 'story_s02_brief_16';
/** Events that must jump ahead of routine chatter once the current line ends. */
const ALERT_EVENTS: ReadonlySet<RadioEvent> = new Set<RadioEvent>([
  'missile_warning',
  'player_hit',
  'low_hp',
  'stall_warning',
  'enemy_missile_launch',
  'mission_failed',
  'ally_down',
]);
/** story > alert > normal. */
function eventCategory(event: RadioEvent): RadioCategory {
  if (event.startsWith('story_')) return 'story';
  if (ALERT_EVENTS.has(event)) return 'alert';
  return 'normal';
}
function priorityRank(c: RadioCategory): number {
  return c === 'story' ? 2 : c === 'alert' ? 1 : 0;
}
/** Directory where generated IndexTTS voice files live. */
export const RADIO_VOICE_DIR = '/audio/radio';
// === Duration estimate used only as a fallback (no voice file / no audio) ===
// Chinese TTS speaks roughly 4-5 characters per second, English roughly 14.
function estimateDuration(text: string): number {
  const rate = /[\u4e00-\u9fff]/.test(text) ? 4.5 : 14;
  return Math.min(9, Math.max(1.8, text.length / rate));
}
interface LinePool {
  speaker: string;
  side: RadioSide;
  voiceSpeaker: Speaker;
  /** Chinese script line (canonical text, also what the Chinese TTS reads). */
  text: string;
  /**
   * Natural English translation of `text` (per user request: 中英双语字幕).
   * Shown as the subtitle when the UI locale is 'en'. Optional — a line without
   * `en` simply falls back to the Chinese `text`.
   */
  en?: string;
  // Legacy English line once read by the Web Speech API (per user request:
  // 语音英文、字幕中文). Since the switch to Chinese IndexTTS audio this is
  // retained only as documentation and may be omitted for new lines.
  voice?: string;
}
/**
 * Runtime subtitle text for a line: the English translation when the UI locale
 * is 'en' and one exists, otherwise the Chinese line (also the fallback when
 * `en` is missing). Note this only affects the HUD subtitle and the fallback
 * duration estimate — the voice file is always the Chinese TTS take.
 */
function lineText(line: LinePool): string {
  return getLocale() === 'en' && line.en ? line.en : line.text;
}
// Lines are written in a combat-radio tone: terse, codeword-heavy, mission-flavored.
// Multiple variants per event for variety. NOTE: new variants are ALWAYS
// appended at the END of a pool — the array index is part of the audio file
// name (<event>-<idx>.mp3), so inserting in the middle would break file IDs.
const LINES: Record<RadioEvent, LinePool[]> = {
  // === 通用台词 (中文) — subtitle = 中文, 语音 = IndexTTS 中文 ===
  mission_start: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '所有编队，允许开火。敌机来袭，航向二七零。',
    voice: 'All flights, weapons free. Bandits inbound, vector two-seven-zero.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '猛禽编队升空，发现目标立即接敌。',
    voice: 'Raptor flight airborne. Engaging targets on sight.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '幽灵报到，发现敌机。',
    voice: 'Ghost checking in. Tally-ho.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '任务开始，本场空域管制由我负责，各机保持通讯纪律。',
    en: 'Mission is go. I have control of this airspace. All aircraft, maintain radio discipline.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '明白，猛禽编队进入战斗空域，按计划展开。',
    en: 'Copy. Raptor flight entering the combat airspace, deploying as briefed.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '幽灵就位，随时可以提供掩护。',
    en: 'Ghost in position. Ready to cover on call.' },
  ],
  target_acquired: [
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '已锁定目标，导弹发射。',
    voice: 'I have tone. Fox two.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '锁定完成，开火。',
    voice: 'Locked on. Firing.' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '信号良好，导弹离架。',
    voice: 'Good tone. Missile away.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '锁定稳定，可以攻击。',
    en: 'Lock is stable. Cleared to fire.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '目标锁定完成，进入发射阵位。',
    en: 'Target locked. Moving into firing position.' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '雷达锁住了，导弹准备就绪。' },
  ],
  missile_launch: [
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '导弹发射！',
    voice: 'Fox two!' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '导弹离架。',
    voice: 'Missile away.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '猛禽一号，导弹发射。',
    voice: 'Raptor one, Fox two.' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '发射，导弹离架。' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '导弹打出去了。' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '猛禽一号，导弹发射，注意跟踪。',
    en: 'Raptor one, missile away. Keep it tracking.' },
  ],
  enemy_missile_launch: [
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '已锁定那架战斗机，开火！',
    voice: 'I have lock on the fighter. Firing.' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹离架，命中一个。',
    voice: 'Missile away. Splash one.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '雷达告警！侦测到导弹发射，急转规避！',
    voice: 'Mud spike! Missile launch detected, break!' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '注意，敌机发射导弹，速度很快！',
    en: 'Heads up, bandit launched. That one is fast.' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '目标进入射程，击落它！' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹追上去了，这下跑不掉。' },
  ],
  kill_fighter: [
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '击落一架战斗机，打得好。',
    voice: 'Splash one fighter. Good kill.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '敌机坠落，确认目视。',
    voice: 'Bandit down. Tally.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '确认击落，一架敌机被消灭。',
    voice: 'Confirm kill. One fighter eliminated.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '又一架敌机坠落，战斗空域正在肃清。',
    en: 'Another bandit down. The airspace is clearing.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '战斗机打下来了，保持警惕。',
    en: 'Fighter splashed. Stay sharp.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '击落确认，敌机残骸正在下坠。',
    en: 'Kill confirmed. Wreckage is falling.' },
  ],
  kill_bomber: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '轰炸机已摧毁，干得漂亮。',
    voice: 'Bomber destroyed. Excellent work.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '重锤落地，大爆炸。',
    voice: 'Heavy down. Big splash.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '轰炸机报销，继续追击。',
    voice: 'Bomber splashed. Press the attack.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '轰炸机解体了，干得干净利落。',
    en: 'Bomber broke apart. Clean work.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '重型目标摧毁，威胁解除。',
    en: 'Heavy target destroyed. Threat is off the board.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '那架大家伙没了，空域清净。',
    en: 'That big one is gone. Airspace is clear.' },
  ],
  multi_kill: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '确认多重击杀，表现出色。',
    voice: 'Multiple kills confirmed. Outstanding.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '三连击！神枪手。',
    voice: 'Three in a row! Gunslinger.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '手感火热！继续保持。',
    voice: 'Hot streak! Keep it up.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '连续击落，你今天状态爆棚。',
    en: 'Kills in a row. You are on fire today.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '一串击落记录，继续保持。',
    en: 'A running string of kills. Keep it going.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '一个接一个，漂亮！',
    en: 'One after another. Beautiful.' },
  ],
  ally_down: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '损失一架友机，调整战术。',
    voice: 'We lost a friendly. Adjust tactics.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '猛禽二号被击落！正在弹射。',
    voice: 'Raptor two is down! Ejecting.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '幽灵中弹——高度丢失，求救。',
    voice: 'Ghost hit — losing altitude. Mayday.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '友机信号消失，坐标已记录，战后组织搜救。',
    en: 'Friendly signal lost. Coordinates logged; SAR after the fight.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '我们少了一架，各机注意补位。',
    en: 'We are one short. Everyone close up the formation.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '有人被打下来了……保持队形，别慌。',
    en: 'We lost someone... hold formation. Steady.' },
  ],
  player_hit: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '你正遭到攻击，注意六点钟方向。',
    voice: 'You\'re taking fire. Watch your six.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机，你中弹了！情况如何？',
    voice: 'Lead, you\'re hit! Status?' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '长机冒烟了，撑住！',
    voice: 'Smoke on lead. Hang in there.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '长机中弹，损伤评估如何？',
    en: 'Lead is hit. Give me a damage report.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机被命中了，先脱离火力！',
    en: 'Lead took a hit. Break off the fire first.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '我看到你机身上冒火了，立即脱离！',
    en: 'I have flames on your airframe. Break off now.' },
  ],
  missile_warning: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '导弹来袭！急转！急转！急转！',
    voice: 'Missile inbound! Break, break, break!' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机，导弹咬住你了！投放热焰弹！',
    voice: 'Lead, missile on you! Deploy flares!' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '现在急转！投放干扰弹！',
    voice: 'Break now! Deploy countermeasures!' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '导弹接近中，三、二……规避！',
    en: 'Missile closing... three, two... evade!' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机，后面有导弹，做急转弯！',
    en: 'Lead, missile behind you. Break hard!' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '拉起来！导弹正追着你！',
    en: 'Pull up! It is chasing you!' },
  ],
  low_hp: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '你的机体严重受损，立即返航。',
    voice: 'Your aircraft is critical. RTB immediately.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机，你伤得不轻，撤出战斗。',
    voice: 'Lead, you\'re battered. Fall back.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '长机，快撤！你被打成筛子了。',
    voice: 'Get out of there, lead. You\'re shredded.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '机体损伤严重，立刻脱离战斗区域。',
    en: 'Airframe damage is severe. Leave the combat area now.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '长机你的损伤太大，别恋战，撤！',
    en: 'Lead, you are too badly hit. Do not stay in the fight. Get out.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '快返航，我们掩护你脱离。',
    en: 'RTB now. We will cover your egress.' },
  ],
  stall_warning: [
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '注意速度，长机，机头压低。',
    voice: 'Watch your speed, lead. Nose down.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '你失速了，加大油门。',
    voice: 'You\'re stalling. Increase throttle.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '空速掉了，机头压下去，别拉飘。',
    en: 'Airspeed is bleeding. Nose down, do not float it.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '失速警告！放平机翼，加推力！',
    en: 'Stall warning! Level the wings and add power!' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '你攻角太大了，推杆！推杆！',
    en: 'Angle of attack is too high. Push the stick, push!' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '气流不稳，稳住姿态，别硬拉。',
    en: 'Airflow is unstable. Hold your attitude, do not force it.' },
  ],
  mission_complete: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '任务完成，所有目标已清除，返航。',
    voice: 'Mission complete. All objectives secured. RTB.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '目标全部消灭，长机飞得漂亮。',
    voice: 'Target neutralized. Good flying, lead.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '收工，撤出战斗。',
    voice: 'That\'s a wrap. Punching out.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '任务目标全部达成，各机返航，保持高度。',
    en: 'All objectives complete. All aircraft RTB, maintain altitude.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '漂亮的行动，全体集合返场。',
    en: 'Beautiful work. Everyone rejoin and recover.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '收队，返场落地。',
    en: 'Wrapping up. Recovering to base.' },
  ],
  mission_failed: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '任务失败，返回基地汇报。',
    voice: 'Mission failed. Return to base for debrief.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '这一仗输了，撤出。',
    voice: 'We lost this one. Fall back.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '行动失利，全体撤离，避免更大损失。',
    en: 'The operation failed. All units egress to avoid further losses.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '撤吧，保存力量，下次再来。',
    en: 'Pull out. Save the strength, we go again next time.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '战况不利，撤退路线已通报各机。',
    en: 'Situation is unfavorable. Egress routes passed to all aircraft.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '这一局不行，先撤出交火区域。',
    en: 'This one is lost. Clear the engagement area.' },
  ],
  no_target: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '未指定目标，请切换目标。',
    voice: 'No target designated. Cycle targets.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '没有指定目标，检查你的锁敌雷达。',
    en: 'No target designated. Check your targeting radar.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '目标丢失，重新搜索空域。',
    en: 'Target lost. Re-sweep the airspace.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '请先锁定一个目标再开火。',
    en: 'Lock a target before you fire.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '当前没有可攻击的目标。',
    en: 'No valid target at this time.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '目标雷达信号丢失，请重新捕获。',
    en: 'Target radar return lost. Re-acquire.' },
  ],
  weapon_empty: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '弹药耗尽，节约使用。',
    voice: 'Weapons exhausted. Conserve ammunition.' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '导弹打光了，只剩机炮。',
    voice: 'Winchester on missiles. Guns only.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '该武器系统弹药清零，切换备用武器。',
    en: 'That weapon system is empty. Switch to your backup.' },
    { speaker: '玩家', side: 'ally', voiceSpeaker: 'player', text: '这型弹药打光了，换别的上。' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '弹药用尽，节约下一发。',
    en: 'Ordnance exhausted. Make the next one count.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '你的挂架空了，回航补弹吧。',
    en: 'Your racks are empty. Come home and rearm.' },
  ],
  engage: [
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '发现那架战斗机，接敌。',
    voice: 'Tally on the fighter. Engaging.' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '对长机发射雷达弹。',
    voice: 'Fox one on the lead aircraft.' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '目视敌机，压上去！' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '咬住长机，打掉他们的前锋。' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '三号机，和我左右包夹那架战斗机。' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '接敌！保持高度优势。' },
  ],
  disengage: [
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '他在我六点钟！脱离！',
    voice: 'He\'s on my six! Breaking off!' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '脱离战斗，丢失目视。',
    voice: 'Disengaging. Lost visual.' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '火力太猛，撤出交战。' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '退出航线，重新集结。' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '先拉开距离，别硬拼。' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '我脱离接触了，汇报情况。' },
  ],
  taunt: [
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '你飞得像运输机飞行员，去死吧。',
    voice: 'You fly like a cargo pilot. Die.' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '今天你别想逃，战斗机。',
    voice: 'No escape for you today, fighter.' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '你已经在我瞄准镜里了。',
    voice: 'I have you in my sights.' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '就这点本事，也敢来闯这片空域？' },
    { speaker: '敌机1号', side: 'enemy', voiceSpeaker: 'enemy1', text: '你躲导弹的样子还挺卖力。' },
    { speaker: '敌机2号', side: 'enemy', voiceSpeaker: 'enemy2', text: '打下来一架，你们就少一架。' },
  ],
  bogey_dopple: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '十二点钟方向出现不明机群，接敌。',
    voice: 'Bogey dopple at twelve o\'clock. Merge.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '敌机接敌，注意间距。',
    voice: 'Bogeys merging. Watch your spacing.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '不明机群正在靠近，高度六千。',
    en: 'Unknown group closing, altitude six thousand.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '前方出现接触，准备拦截。',
    en: 'Contact ahead. Prepare to intercept.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '目标转向你了，注意航向。',
    en: 'They are turning into you. Watch your heading.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '目视接触，识别后敌再打。',
    en: 'Visual contact. Identify before you engage.' },
  ],
  wingman_attack: [
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '收到，接敌，武器就绪。',
    voice: 'Copy, engaging bandits. Weapons hot.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '猛禽二号进场，长机注意六点。',
    voice: 'Raptor two going in. Watch your six, lead.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '发现敌机，现在接敌。',
    voice: 'Tally on the bandit. Engaging now.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '收到，我对准那架敌机了。',
    en: 'Copy. I am lined up on that bandit.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '接敌中，打完就归位。',
    en: 'Engaging now. I will rejoin after the pass.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '开始攻击，机炮伺候。',
    en: 'Beginning my attack. Guns it is.' },
  ],
  wingman_cover: [
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '转入防御，长机我来掩护。',
    voice: 'Going defensive. Covering you, lead.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '我盯着你的六点，放手进攻。',
    voice: 'I have your six. Press the attack.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '掩护中，需要就投干扰弹。',
    voice: 'Covering. Pop flares if needed.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '我咬住你身后的敌机了。',
    en: 'I have the bandit behind you.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '掩护位置确认，放心打。',
    en: 'Cover position set. Take your shot.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '把敌机甩给我，专心干你的事。',
    en: 'Leave that bandit to me. Focus on your job.' },
  ],
  wingman_form: [
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '正在编队，归位。',
    voice: 'Forming up. Rejoining formation.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '已在长机翼侧，收紧间距。',
    voice: 'On your wing, lead. Tightening up.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '返回编队，目视确认。',
    voice: 'Coming back to formation. Visual.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '编队到位，距离拉近。',
    en: 'Formation set. Closing the distance.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '跟上你机翼，右前方待命。',
    en: 'On your wing, holding right front.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '阵型保持，随时待命出击。',
    en: 'Formation held. Ready to engage on your word.' },
  ],
  wingman_kill: [
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '击落一架！猛禽二号得分。',
    voice: 'Splash one! Raptor two scores.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '敌机报销，空域清净。',
    voice: 'Bandit splashed. Tally cleared.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '打掉了！重新接敌。',
    voice: 'Got him! Re-engaging.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '又解决一个，猛禽二号继续搜索。',
    en: 'Another one down. Raptor two continuing the sweep.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '击落确认！敌机变成火球了。',
    en: 'Kill confirmed! The bandit is a fireball.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '这架归我了，继续找下一个。',
    en: 'That one is mine. Looking for the next.' },
  ],
  wingman_hit: [
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '我中弹了！正在尝试恢复。',
    voice: 'I\'m hit! Trying to recover.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '猛禽二号遭火力，脱离。',
    voice: 'Raptor two taking fire. Breaking.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '我被击中了，右翼受损！',
    en: 'I am hit. Right wing is damaged!' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '机身中弹，正在检查损伤。',
    en: 'Took rounds in the fuselage. Checking the damage.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '发动机告警，动力下降，脱离战斗。',
    en: 'Engine warning, losing power. Breaking off.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '损伤可控，我继续掩护你，长机。',
    en: 'Damage is manageable. I am still covering you, lead.' },
  ],
  weather_warning: [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '天气恶化，前方有强烈颠簸。',
    voice: 'Weather deteriorating. Severe turbulence ahead.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '侦测到雷暴活动，保持间距。',
    voice: 'Lightning activity detected. Maintain separation.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '风切变！注意空速。',
    voice: 'Windshear! Watch your airspeed.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '前方有积雨云，建议绕航或保持高度。',
    en: 'Cumulonimbus ahead. Recommend deviation or hold altitude.' },
    { speaker: '猛禽2号', side: 'ally', voiceSpeaker: 'ally2', text: '气流很强，握紧操纵杆。',
    en: 'Heavy turbulence. Grip the stick.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '能见度下降，保持目视间隔。',
    en: 'Visibility dropping. Keep visual separation.' },
  ],
  // === Missile miss callout (per user request: 导弹未命中播报) ===
  missile_miss: [
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '导弹脱靶了，没有命中。',
    voice: 'Missile went ballistic. No joy.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '被躲掉了，敌机仍在追踪。',
    voice: 'Shot evaded. Bandit still tracking.' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '发射落空，重新接敌。',
    voice: 'Fox two miss. Re-engage.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '他躲开了，再试一次。',
    voice: 'He dodged it. Try again.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '他甩掉导弹了，再来一轮。',
    en: 'He shook it off. Go around again.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '导弹脱靶，敌机仍在你九点钟方向。',
    en: 'Shot missed. Bandit is still at your nine o\'clock.' },
  ],
  // === Splash callout (per user request: 击落敌机播报) ===
  splash_call: [
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '击落一架！',
    voice: 'Splash one!' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '敌机击落！',
    voice: 'Bandit splashed!' },
    { speaker: '猛禽1号', side: 'ally', voiceSpeaker: 'ally1', text: '漂亮！击落一架。',
    voice: 'Good kill! Splash one.' },
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '确认击落，一个目标消失。',
    voice: 'Confirm splash. One down.' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '打掉了！',
    voice: 'Got him!' },
    { speaker: '幽灵', side: 'ally', voiceSpeaker: 'ally2', text: '目标爆炸，确认击落。',
    en: 'Target exploded. Kill confirmed.' },
  ],
  // === T-00 剧情专用台词 (按叙事固定的台词,不做随机扩充) ===
  story_t00_intro: [
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '白隼小队，这里是伊予滩空降第三突击队，队长佐藤。',
    voice: 'Peregrine flight, this is Iyotani Airborne Assault Three, leader Sato.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '目标就在前方山谷——关东军的雪山预警雷达站，五门激光防空炮沿山脊一字排开。',
    voice: 'Target ahead in the valley: the Kanto snow-peak early-warning radar site, five laser AA guns lined along the ridge.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '我们负责低空突入炸地面目标，你们负责清空空域、压制防空火力，掩护我们抵近。',
    voice: 'We go in low to hit the ground targets; you clear the sky and suppress the flak, cover our approach.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '关东的守备队增援很快，速战速决。',
    voice: 'Kanto reinforcements will be fast. Make it quick.' },
    { speaker: '白隼1号', side: 'ally', voiceSpeaker: 'player', text: '收到。全体注意，低空贴山脊进，先敲掉最外侧的激光炮，给空降部队开缺口。',
    voice: 'Copy. All units, stay low along the ridge. Knock out the outer laser first, open a gap for the assault force.' },
  ],
  story_t00_engage: [
    { speaker: '守备队', side: 'enemy', voiceSpeaker: 'enemy1', text: '发现不明机群！有联合国标识，配合关西空降部队！一级警备，战斗机升空拦截！',
    voice: 'Unknown aircraft! UN markings, working with the Kansai airborne! Full alert, scramble the fighters!' },
    { speaker: '守备队', side: 'enemy', voiceSpeaker: 'enemy2', text: '防空炮全体开机，把他们打出去！',
    voice: 'All AA batteries online! Drive them out!' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '白隼小队，左路第二门炮火力最猛，先敲掉它！我们被压得抬不起头！',
    voice: 'Peregrine, the second gun on the left flank is the heaviest! Take it out first! We are pinned down!' },
  ],
  story_t00_laser1: [
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '一号炮位摧毁！干得好，继续推进！',
    voice: 'Gun one down! Good work, keep pushing!' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '注意，后方机场的增援过来了，数量不少！',
    voice: 'Heads up, reinforcements from the rear airfield! Plenty of them!' },
  ],
  story_t00_laser3: [
    { speaker: '守备队', side: 'enemy', voiceSpeaker: 'enemy1', text: '他们冲进来了！呼叫总部支援！请求雪鸮小队出动！',
    voice: 'They broke through! Requesting HQ support! Calling the Snowy Owl squadron!' },
  ],
  story_t00_laser5: [
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '防空炮全清！我们冲雷达站主楼了，你们掩护上空！',
    voice: 'All AA down! We are moving on the radar main building! Cover us from above!' },
  ],
  story_t00_radar_down: [
    { speaker: '守备队', side: 'enemy', voiceSpeaker: 'enemy1', text: '雷达站！雷达站被炸了！',
    voice: 'The radar station! The radar station is gone!' },
    { speaker: '守备队', side: 'enemy', voiceSpeaker: 'enemy2', text: '雪鸮小队呢？！他们怎么还没来——',
    voice: 'Where is the Snowy Owl squadron?! Why are they not here yet—' },
  ],
  story_t00_ace_enter: [
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '关西非法武装，还有联合国佣兵。',
    voice: 'Kansai irregulars... and United Nations mercenaries.' },
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们胆敢进犯国境守备区，后果自负。',
    voice: 'You dare invade our border defense zone. You will face the consequences.' },
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '我是国境永固守备队，雪鸮小队队长，长谷川。',
    voice: 'I am Hasegawa, leader of the Snowy Owl squadron, Eternal Border Defense Force.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '哟，公府的王牌老爷们终于肯露脸了？',
    voice: 'Oh? The grand aces of the government finally show their faces?' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '躲在雷达站后面缩了半天，还以为你们要一直当缩头乌龟。',
    voice: 'Hiding behind the radar station all this time, I thought you would stay turtles forever.' },
  ],
  story_t00_ace_engage: [
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '放肆。国境重地，岂容你们撒野。',
    voice: 'Insolent. This is sacred border ground. You will not run wild here.' },
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '全体编队——攻击准备。',
    voice: 'All units. Prepare to attack.' },
  ],
  story_t00_ace_strain: [
    { speaker: '雪鸮队员', side: 'enemy', voiceSpeaker: 'enemy2', text: '啧？这联合国的飞行员，有点东西。',
    voice: 'Tch. This UN pilot... has some skill.' },
    { speaker: '雪鸮队员', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹跟紧点，别丢面子。',
    voice: 'Keep the missiles tight. Do not lose face.' },
    { speaker: '雪鸮队员', side: 'enemy', voiceSpeaker: 'enemy2', text: '可恶，机动过载了…… 舵面响应变慢！',
    voice: 'Damn, over-G! Control surfaces are getting sluggish!' },
  ],
  story_t00_ace_kill1: [
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '三号机被击落…… 可恶。全体注意，不要硬接导弹，利用山体绕！',
    voice: 'Three is down... damn it. All units, do not take the missiles head-on! Use the mountains!' },
  ],
  story_t00_ace_kill5: [
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '就剩我一个了吗……',
    voice: 'Am I... the last one left...' },
    { speaker: '雪鸮队长·长谷川', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们…… 根本不是普通维和部队。你们到底是什么人？',
    voice: 'You people... you are not an ordinary peacekeeping force. Who the hell are you?' },
  ],
  story_t00_end: [
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '全灭了…… 公府的王牌，也不过如此嘛。',
    voice: 'Wiped out... the government aces, nothing special after all.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '白隼小队，干得漂亮。雷达站已经夷平，我们准备撤了。',
    voice: 'Peregrine flight, beautiful work. The radar station is rubble, we are pulling out.' },
    { speaker: '关西突击队·佐藤', side: 'ally', voiceSpeaker: 'ally1', text: '回头补给站见，奖金少不了你们的。',
    voice: 'See you at the supply depot. Your bonus is waiting.' },
    { speaker: '白隼1号', side: 'ally', voiceSpeaker: 'player', text: '任务完成。全体集合，返航。',
    voice: 'Mission complete. All units, regroup and RTB.' },
    { speaker: '白隼1号', side: 'ally', voiceSpeaker: 'player', text: '…… 关东军的王牌，比预想的要弱。不对，总觉得哪里不对劲。算了，先回去再说。',
    voice: 'The Kanto aces... weaker than expected. No, something feels off. Whatever. Head home first.' },
  ],
  // === S-01 剧情台词 · s0_awacs ===
  story_s01_s0_awacs_01: [
    { speaker: '预警机', side: 'awacs', voiceSpeaker: 'awacs', text: '全体注意，雷达捕捉到超大信号。方位090，距离40。这不是常规目标。重复，这不是常规目标。',
    en: 'All units, radar has a massive contact. Bearing zero-nine-zero, range four-zero. This is no ordinary target. I say again, this is no ordinary target.', voice: 'All units, radar has a massive contact. Bearing zero-nine-zero, range four-zero. This is no ordinary target. I say again, this is no ordinary target.' },
  ],
  // === S-01 剧情台词 · s0_escort ===
  story_s01_s0_escort_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '这里是堡垒。进入目标空域。猎犬队，展开护航阵型。',
    en: 'This is Bastion. Entering target airspace. Hound flight, spread into escort formation.', voice: 'This is Bastion. Entering target airspace. Hound flight, spread into escort formation.' },
  ],
  story_s01_s0_escort_02: [
    { speaker: '猎犬1', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬1，目视确认。敌方战斗机四架，方位060。',
    en: 'Hound one, visual confirmed. Four enemy fighters, bearing zero-six-zero.', voice: 'Hound one, visual confirmed. Four enemy fighters, bearing zero-six-zero.' },
  ],
  story_s01_s0_escort_03: [
    { speaker: '猎犬2', side: 'enemy', voiceSpeaker: 'enemy2', text: '收到。保持编队，别脱离堡垒防空圈。',
    en: 'Copy. Hold formation. Do not leave Bastion air defense ring.', voice: 'Copy. Hold formation. Do not leave Bastion air defense ring.' },
  ],
  story_s01_s0_escort_04: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '这是我们的首秀。让他们看看，什么叫空中战舰。',
    en: 'This is our debut. Let them see what an air warship means.', voice: 'This is our debut. Let them see what an air warship means.' },
  ],
  story_s01_s0_escort_05: [
    { speaker: '猎犬3', side: 'enemy', voiceSpeaker: 'enemy2', text: '目标锁定。准备接敌。',
    en: 'Target locked. Preparing to engage.', voice: 'Target locked. Preparing to engage.' },
  ],
  story_s01_s0_escort_06: [
    { speaker: '猎犬1', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬队，自由开火。别让他们靠近堡垒。',
    en: 'Hound flight, weapons free. Do not let them near Bastion.', voice: 'Hound flight, weapons free. Do not let them near Bastion.' },
  ],
  story_s01_s0_escort_07: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '刺猬炮位，预热。等待进入射程。',
    en: 'Hedgehog mounts, warm up. Wait for them to enter range.', voice: 'Hedgehog mounts, warm up. Wait for them to enter range.' },
  ],
  story_s01_s0_escort_08: [
    { speaker: '猎犬4', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们来了。速度很快。',
    en: 'Here they come. They are fast.', voice: 'Here they come. They are fast.' },
  ],
  story_s01_s0_escort_09: [
    { speaker: '猎犬2', side: 'enemy', voiceSpeaker: 'enemy2', text: '别慌。堡垒在我们后面。',
    en: 'Steady. Bastion is behind us.', voice: 'Steady. Bastion is behind us.' },
  ],
  story_s01_s0_escort_10: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '所有单位注意，敌方进入外围警戒圈。允许交战。',
    en: 'All units, enemy has entered the outer warning ring. Engage at will.', voice: 'All units, enemy has entered the outer warning ring. Engage at will.' },
  ],
  // === S-01 剧情台词 · s1_open ===
  story_s01_s1_open_01: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '刺猬炮位，自由开火。别让他们靠近。',
    en: 'Hedgehog mounts, weapons free. Do not let them close.', voice: 'Hedgehog mounts, weapons free. Do not let them close.' },
  ],
  story_s01_s1_open_02: [
    { speaker: '刺猬1', side: 'enemy', voiceSpeaker: 'enemy2', text: '机炮锁定。开火。',
    en: 'Gun locked. Firing.', voice: 'Gun locked. Firing.' },
  ],
  story_s01_s1_open_03: [
    { speaker: '刺猬2', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹发射器就绪。发射。',
    en: 'Missile launcher ready. Launching.', voice: 'Missile launcher ready. Launching.' },
  ],
  story_s01_s1_open_04: [
    { speaker: '猎犬1', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们想拔我们的牙。拦住他们。',
    en: 'They want to pull our teeth. Stop them.', voice: 'They want to pull our teeth. Stop them.' },
  ],
  story_s01_s1_open_05: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '表面挂点受损。备用部件准备装填。',
    en: 'Hull mount damaged. Prepare spare components for reload.', voice: 'Hull mount damaged. Prepare spare components for reload.' },
  ],
  // === S-01 剧情台词 · s1_mount ===
  story_s01_s1_mount_01: [
    { speaker: '刺猬3', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们在打上表面！转移火力！',
    en: 'They are hitting the upper surface! Shift fire!', voice: 'They are hitting the upper surface! Shift fire!' },
  ],
  story_s01_s1_mount_02: [
    { speaker: '猎犬2', side: 'enemy', voiceSpeaker: 'enemy2', text: '别管战斗机，打那个带导弹的！',
    en: 'Forget the fighters, hit the one with the missiles!', voice: 'Forget the fighters, hit the one with the missiles!' },
  ],
  story_s01_s1_mount_03: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '他们以为打掉几个炮位就能赢？可笑。',
    en: 'They think killing a few mounts wins this? Laughable.', voice: 'They think killing a few mounts wins this? Laughable.' },
  ],
  story_s01_s1_mount_04: [
    { speaker: '刺猬4', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹发射器2失效！重复，发射器2没了！',
    en: 'Missile launcher two is down! I say again, launcher two is gone!', voice: 'Missile launcher two is down! I say again, launcher two is gone!' },
  ],
  story_s01_s1_mount_05: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '表面火力还剩75%。继续射击。',
    en: 'Surface firepower at seventy-five percent. Keep firing.', voice: 'Surface firepower at seventy-five percent. Keep firing.' },
  ],
  // === S-01 剧情台词 · s1_loss ===
  story_s01_s1_loss_01: [
    { speaker: '猎犬3', side: 'enemy', voiceSpeaker: 'enemy2', text: '我被锁定了！无法摆脱！',
    en: 'I am locked up! Cannot shake it!', voice: 'I am locked up! Cannot shake it!' },
  ],
  story_s01_s1_loss_02: [
    { speaker: '猎犬1', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬3，机动！释放干扰弹！',
    en: 'Hound three, maneuver! Pop decoys!', voice: 'Hound three, maneuver! Pop decoys!' },
  ],
  story_s01_s1_loss_03: [
    { speaker: '猎犬3', side: 'enemy', voiceSpeaker: 'enemy2', text: '太晚了——！',
    en: 'Too late...!', voice: 'Too late...!' },
  ],
  story_s01_s1_loss_04: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '猎犬3被击落。猎犬队，继续掩护。',
    en: 'Hound three is down. Hound flight, keep covering.', voice: 'Hound three is down. Hound flight, keep covering.' },
  ],
  // === S-01 剧情台词 · s1_mount2 ===
  story_s01_s1_mount2_01: [
    { speaker: '刺猬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '机炮过热。需要冷却。',
    en: 'Gun overheating. Need to cool it.', voice: 'Gun overheating. Need to cool it.' },
  ],
  story_s01_s1_mount2_02: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '别停。他们还在冲。',
    en: 'Do not stop. They are still charging in.', voice: 'Do not stop. They are still charging in.' },
  ],
  story_s01_s1_mount2_03: [
    { speaker: '刺猬6', side: 'enemy', voiceSpeaker: 'enemy2', text: '上表面出现缺口！他们从上面来了！',
    en: 'Breach on the upper surface! They are coming in from above!', voice: 'Breach on the upper surface! They are coming in from above!' },
  ],
  story_s01_s1_mount2_04: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '让他们上来。下面还有导弹。',
    en: 'Let them come up. We still have missiles below.', voice: 'Let them come up. We still have missiles below.' },
  ],
  story_s01_s1_mount2_05: [
    { speaker: '猎犬4', side: 'enemy', voiceSpeaker: 'enemy2', text: '堡垒，敌方正在集中攻击左侧挂点。',
    en: 'Bastion, enemy is massing on the port mount.', voice: 'Bastion, enemy is massing on the port mount.' },
  ],
  story_s01_s1_mount2_06: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '收到。左侧炮位，优先拦截。',
    en: 'Copy. Port mounts, intercept as priority.', voice: 'Copy. Port mounts, intercept as priority.' },
  ],
  story_s01_s1_mount2_07: [
    { speaker: '刺猬7', side: 'enemy', voiceSpeaker: 'enemy2', text: '左侧机炮被毁！重复，左侧机炮没了！',
    en: 'Port gun destroyed! I say again, port gun is gone!', voice: 'Port gun destroyed! I say again, port gun is gone!' },
  ],
  story_s01_s1_mount2_08: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '第一阶段防御下降至50%。继续。',
    en: 'Stage one defense down to fifty percent. Continue.', voice: 'Stage one defense down to fifty percent. Continue.' },
  ],
  story_s01_s1_mount2_09: [
    { speaker: '猎犬2', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们打得太快了。这些家伙不是普通飞行员。',
    en: 'They are hitting too fast. These are not ordinary pilots.', voice: 'They are hitting too fast. These are not ordinary pilots.' },
  ],
  story_s01_s1_mount2_10: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '稳住。我们还有第二阶段。',
    en: 'Steady. We still have stage two.', voice: 'Steady. We still have stage two.' },
  ],
  // === S-01 剧情台词 · s2_trigger ===
  story_s01_s2_trigger_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '第一阶段防御失效。切换至第二阶段配置。释放第二航空大队。',
    en: 'Stage one defense failed. Switching to stage two config. Releasing second air group.', voice: 'Stage one defense failed. Switching to stage two config. Releasing second air group.' },
  ],
  // === S-01 剧情台词 · s2_open ===
  story_s01_s2_open_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '第一阶段防御失效。切换配置。释放第二航空大队。',
    en: 'Stage one defense failed. Switching config. Releasing second air group.', voice: 'Stage one defense failed. Switching config. Releasing second air group.' },
  ],
  story_s01_s2_open_02: [
    { speaker: '猎犬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬队，弹射。掩护堡垒。',
    en: 'Hound flight, launch. Cover Bastion.', voice: 'Hound flight, launch. Cover Bastion.' },
  ],
  story_s01_s2_open_03: [
    { speaker: '猎犬6', side: 'enemy', voiceSpeaker: 'enemy2', text: '收到。目标空域确认。',
    en: 'Copy. Target airspace confirmed.', voice: 'Copy. Target airspace confirmed.' },
  ],
  story_s01_s2_open_04: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '加速。释放干扰弹。别让他们锁定。',
    en: 'Accelerate. Deploy decoys. Do not let them get a lock.', voice: 'Accelerate. Deploy decoys. Do not let them get a lock.' },
  ],
  story_s01_s2_open_05: [
    { speaker: '刺猬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '导弹更多了。这次他们躲不掉。',
    en: 'More missiles now. They cannot dodge this time.', voice: 'More missiles now. They cannot dodge this time.' },
  ],
  story_s01_s2_open_06: [
    { speaker: '猎犬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '干扰弹投放。他们锁不住。',
    en: 'Decoys out. They cannot hold a lock.', voice: 'Decoys out. They cannot hold a lock.' },
  ],
  story_s01_s2_open_07: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '上表面全部换装导弹发射器。下表面机炮。自由射击。',
    en: 'Upper surface all missile launchers. Lower surface guns. Fire at will.', voice: 'Upper surface all missile launchers. Lower surface guns. Fire at will.' },
  ],
  // === S-01 剧情台词 · s2_mount ===
  story_s01_s2_mount_01: [
    { speaker: '猎犬7', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们在下面！下表面炮位，转向！',
    en: 'They are below! Lower surface mounts, traverse!', voice: 'They are below! Lower surface mounts, traverse!' },
  ],
  story_s01_s2_mount_02: [
    { speaker: '刺猬9', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们在打发射器！上表面需要支援！',
    en: 'They are hitting the launchers! Upper surface needs support!', voice: 'They are hitting the launchers! Upper surface needs support!' },
  ],
  story_s01_s2_mount_03: [
    { speaker: '猎犬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '别脱离。堡垒防空圈还在。',
    en: 'Do not break off. Bastion air defense ring still holds.', voice: 'Do not break off. Bastion air defense ring still holds.' },
  ],
  story_s01_s2_mount_04: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '堡垒速度提升至200。他们追不上。',
    en: 'Bastion accelerating to two hundred. They cannot keep up.', voice: 'Bastion accelerating to two hundred. They cannot keep up.' },
  ],
  story_s01_s2_mount_05: [
    { speaker: '猎犬6', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们还在追。这些疯子。',
    en: 'They are still chasing. Madmen.', voice: 'They are still chasing. Madmen.' },
  ],
  story_s01_s2_mount_06: [
    { speaker: '刺猬10', side: 'enemy', voiceSpeaker: 'enemy2', text: '发射器4失效！他们从缺口进来了！',
    en: 'Launcher four is down! They are coming through the breach!', voice: 'Launcher four is down! They are coming through the breach!' },
  ],
  story_s01_s2_mount_07: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '备用部件还有。继续装填。让他们打。',
    en: 'We still have spares. Keep reloading. Let them shoot.', voice: 'We still have spares. Keep reloading. Let them shoot.' },
  ],
  // === S-01 剧情台词 · s2_loss ===
  story_s01_s2_loss_01: [
    { speaker: '猎犬7', side: 'enemy', voiceSpeaker: 'enemy2', text: '我被击中了！引擎冒烟！',
    en: 'I am hit! Engine is smoking!', voice: 'I am hit! Engine is smoking!' },
  ],
  story_s01_s2_loss_02: [
    { speaker: '猎犬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬7，返航！重复，返航！',
    en: 'Hound seven, RTB! I say again, RTB!', voice: 'Hound seven, RTB! I say again, RTB!' },
  ],
  story_s01_s2_loss_03: [
    { speaker: '猎犬7', side: 'enemy', voiceSpeaker: 'enemy2', text: '回不去了……弹射！',
    en: 'Cannot make it back... ejecting!', voice: 'Cannot make it back... ejecting!' },
  ],
  story_s01_s2_loss_04: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '猎犬7损失。剩余单位继续。',
    en: 'Hound seven lost. Remaining units continue.', voice: 'Hound seven lost. Remaining units continue.' },
  ],
  // === S-01 剧情台词 · s2_mount2 ===
  story_s01_s2_mount2_01: [
    { speaker: '刺猬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '上表面火力下降。他们快打完了。',
    en: 'Upper surface firepower dropping. They are nearly through.', voice: 'Upper surface firepower dropping. They are nearly through.' },
  ],
  story_s01_s2_mount2_02: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '让他们打。打完还有第三阶段。',
    en: 'Let them shoot. Stage three comes after.', voice: 'Let them shoot. Stage three comes after.' },
  ],
  story_s01_s2_mount2_03: [
    { speaker: '猎犬6', side: 'enemy', voiceSpeaker: 'enemy2', text: '堡垒，敌方正在攻击后部发射器。',
    en: 'Bastion, enemy is hitting the aft launchers.', voice: 'Bastion, enemy is hitting the aft launchers.' },
  ],
  story_s01_s2_mount2_04: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '后部炮位，拦截。',
    en: 'Aft mounts, intercept.', voice: 'Aft mounts, intercept.' },
  ],
  story_s01_s2_mount2_05: [
    { speaker: '刺猬11', side: 'enemy', voiceSpeaker: 'enemy2', text: '后部发射器被毁！重复，后部没了！',
    en: 'Aft launcher destroyed! I say again, aft is gone!', voice: 'Aft launcher destroyed! I say again, aft is gone!' },
  ],
  story_s01_s2_mount2_06: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '第二阶段也快了。准备激光阵列。',
    en: 'Stage two is nearly done too. Prepare the laser array.', voice: 'Stage two is nearly done too. Prepare the laser array.' },
  ],
  story_s01_s2_mount2_07: [
    { speaker: '猎犬5', side: 'enemy', voiceSpeaker: 'enemy2', text: '激光？他们要放激光了？',
    en: 'Lasers? They are going to fire lasers?', voice: 'Lasers? They are going to fire lasers?' },
  ],
  story_s01_s2_mount2_08: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '所有单位，撤离激光射界。重复，撤离射界。',
    en: 'All units, clear the laser firing line. I say again, clear the line.', voice: 'All units, clear the laser firing line. I say again, clear the line.' },
  ],
  // === S-01 剧情台词 · s3_trigger ===
  story_s01_s3_trigger_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '第三阶段防御启动。激光阵列上线。轻型舰队，进入战区。',
    en: 'Stage three defense active. Laser array online. Light flotilla, enter the combat zone.', voice: 'Stage three defense active. Laser array online. Light flotilla, enter the combat zone.' },
  ],
  // === S-01 剧情台词 · s3_open ===
  story_s01_s3_open_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '第三阶段防御启动。长矛阵列上线。铁砧舰队，进入战区。',
    en: 'Stage three defense active. Lance array online. Anvil flotilla, enter the combat zone.', voice: 'Stage three defense active. Lance array online. Anvil flotilla, enter the combat zone.' },
  ],
  story_s01_s3_open_02: [
    { speaker: '铁砧1', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧1，抵达战区。开始释放蜂群。',
    en: 'Anvil one, on station. Beginning swarm release.', voice: 'Anvil one, on station. Beginning swarm release.' },
  ],
  story_s01_s3_open_03: [
    { speaker: '铁砧2', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧2，收到。炮位激活。',
    en: 'Anvil two, copy. Gun mounts active.', voice: 'Anvil two, copy. Gun mounts active.' },
  ],
  story_s01_s3_open_04: [
    { speaker: '长矛1', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛1充能。目标锁定。',
    en: 'Lance one charging. Target locked.', voice: 'Lance one charging. Target locked.' },
  ],
  story_s01_s3_open_05: [
    { speaker: '长矛2', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛2充能。别让他们靠近。',
    en: 'Lance two charging. Do not let them close.', voice: 'Lance two charging. Do not let them close.' },
  ],
  story_s01_s3_open_06: [
    { speaker: '蜂群控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '蜂群释放。自主攻击。',
    en: 'Swarm released. Autonomous attack.', voice: 'Swarm released. Autonomous attack.' },
  ],
  story_s01_s3_open_07: [
    { speaker: '猎犬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬队，掩护长矛。别让他们打激光。',
    en: 'Hound flight, cover the Lances. Do not let them hit the lasers.', voice: 'Hound flight, cover the Lances. Do not let them hit the lasers.' },
  ],
  story_s01_s3_open_08: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '侧面对敌。让他们看看激光的威力。',
    en: 'Turn broadside. Let them see what the lasers can do.', voice: 'Turn broadside. Let them see what the lasers can do.' },
  ],
  // === S-01 剧情台词 · s3_mount ===
  story_s01_s3_mount_01: [
    { speaker: '长矛1', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛1发射。烧穿他们。',
    en: 'Lance one firing. Burn them through.', voice: 'Lance one firing. Burn them through.' },
  ],
  story_s01_s3_mount_02: [
    { speaker: '长矛2', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛2发射。目标蒸发。',
    en: 'Lance two firing. Target vaporized.', voice: 'Lance two firing. Target vaporized.' },
  ],
  story_s01_s3_mount_03: [
    { speaker: '长矛3', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们躲开了。继续充能。',
    en: 'They dodged. Keep charging.', voice: 'They dodged. Keep charging.' },
  ],
  story_s01_s3_mount_04: [
    { speaker: '铁砧1', side: 'enemy', voiceSpeaker: 'enemy2', text: '蜂群，左舷释放。封锁他们的机动。',
    en: 'Swarm, release to port. Deny their maneuver.', voice: 'Swarm, release to port. Deny their maneuver.' },
  ],
  story_s01_s3_mount_05: [
    { speaker: '蜂群控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '蜂群锁定。自杀式攻击。',
    en: 'Swarm locked on. Kamikaze attack.', voice: 'Swarm locked on. Kamikaze attack.' },
  ],
  story_s01_s3_mount_06: [
    { speaker: '猎犬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '无人机太多了！我甩不掉！',
    en: 'Too many drones! I cannot shake them!', voice: 'Too many drones! I cannot shake them!' },
  ],
  story_s01_s3_mount_07: [
    { speaker: '猎犬9', side: 'enemy', voiceSpeaker: 'enemy2', text: '别管无人机！打激光炮！',
    en: 'Forget the drones! Hit the laser cannons!', voice: 'Forget the drones! Hit the laser cannons!' },
  ],
  story_s01_s3_mount_08: [
    { speaker: '长矛1', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛1被击中！充能中断！',
    en: 'Lance one is hit! Charging interrupted!', voice: 'Lance one is hit! Charging interrupted!' },
  ],
  // === S-01 剧情台词 · s3_anvil ===
  story_s01_s3_anvil_01: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '长矛1失效！长矛2、3、4继续。',
    en: 'Lance one is down! Lances two, three, four continue.', voice: 'Lance one is down! Lances two, three, four continue.' },
  ],
  story_s01_s3_anvil_02: [
    { speaker: '铁砧1', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧1受损！六个部件全毁！失去动力！',
    en: 'Anvil one damaged! All six sections destroyed! Losing power!', voice: 'Anvil one damaged! All six sections destroyed! Losing power!' },
  ],
  story_s01_s3_anvil_03: [
    { speaker: '铁砧2', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧1在坠落！重复，铁砧1坠落！',
    en: 'Anvil one is falling! I say again, Anvil one is going down!', voice: 'Anvil one is falling! I say again, Anvil one is going down!' },
  ],
  story_s01_s3_anvil_04: [
    { speaker: '铁砧1', side: 'enemy', voiceSpeaker: 'enemy2', text: '这里是铁砧1……我们还在滑……停不下来……',
    en: 'This is Anvil one... we are still sliding... cannot stop...', voice: 'This is Anvil one... we are still sliding... cannot stop...' },
  ],
  story_s01_s3_anvil_05: [
    { speaker: '铁砧2', side: 'enemy', voiceSpeaker: 'enemy2', text: '别管铁砧1。继续攻击。',
    en: 'Forget Anvil one. Continue the attack.', voice: 'Forget Anvil one. Continue the attack.' },
  ],
  story_s01_s3_anvil_06: [
    { speaker: '蜂群控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '蜂群损失30%。继续释放。',
    en: 'Swarm losses thirty percent. Continue release.', voice: 'Swarm losses thirty percent. Continue release.' },
  ],
  // === S-01 剧情台词 · s3_mount2 ===
  story_s01_s3_mount2_01: [
    { speaker: '长矛2', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛2被毁！重复，长矛2没了！',
    en: 'Lance two destroyed! I say again, Lance two is gone!', voice: 'Lance two destroyed! I say again, Lance two is gone!' },
  ],
  story_s01_s3_mount2_02: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '激光阵列损失两门。剩余两门继续充能。',
    en: 'Laser array lost two cannons. Remaining two keep charging.', voice: 'Laser array lost two cannons. Remaining two keep charging.' },
  ],
  story_s01_s3_mount2_03: [
    { speaker: '铁砧2', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧2核心被毁！要炸了！',
    en: 'Anvil two core is destroyed! She is going to blow!', voice: 'Anvil two core is destroyed! She is going to blow!' },
  ],
  story_s01_s3_mount2_04: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧2坠落！惯性太大，停不下来！',
    en: 'Anvil two is falling! Too much momentum, cannot stop!', voice: 'Anvil two is falling! Too much momentum, cannot stop!' },
  ],
  story_s01_s3_mount2_05: [
    { speaker: '铁砧2', side: 'enemy', voiceSpeaker: 'enemy2', text: '触地倒计时……5……4……',
    en: 'Impact countdown... five... four...', voice: 'Impact countdown... five... four...' },
  ],
  story_s01_s3_mount2_06: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '铁砧2消失。铁砧3，继续。',
    en: 'Anvil two is gone. Anvil three, continue.', voice: 'Anvil two is gone. Anvil three, continue.' },
  ],
  story_s01_s3_mount2_07: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧3，抵达战区。释放全部蜂群。',
    en: 'Anvil three, on station. Releasing all swarms.', voice: 'Anvil three, on station. Releasing all swarms.' },
  ],
  story_s01_s3_mount2_08: [
    { speaker: '长矛3', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们打掉了长矛3！长矛4还在充能！',
    en: 'They killed Lance three! Lance four is still charging!', voice: 'They killed Lance three! Lance four is still charging!' },
  ],
  story_s01_s3_mount2_09: [
    { speaker: '长矛4', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛4充能完毕。发射！',
    en: 'Lance four fully charged. Firing!', voice: 'Lance four fully charged. Firing!' },
  ],
  story_s01_s3_mount2_10: [
    { speaker: '猎犬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '长矛4被毁！激光阵列失效！',
    en: 'Lance four destroyed! Laser array is down!', voice: 'Lance four destroyed! Laser array is down!' },
  ],
  story_s01_s3_mount2_11: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '……核心暴露。最终协议启动。',
    en: '...Core exposed. Final protocol initiated.', voice: '...Core exposed. Final protocol initiated.' },
  ],
  // === S-01 剧情台词 · s4_open ===
  story_s01_s4_open_01: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '所有防御失效。核心暴露。启动最终协议。所有单位，尽你们所能。',
    en: 'All defenses failed. Core exposed. Final protocol active. All units, do what you can.', voice: 'All defenses failed. Core exposed. Final protocol active. All units, do what you can.' },
  ],
  story_s01_s4_open_02: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '这是最后。我们不会投降。',
    en: 'This is the last stand. We will not surrender.', voice: 'This is the last stand. We will not surrender.' },
  ],
  story_s01_s4_open_03: [
    { speaker: '猎犬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬队，全部弹射。撞也要撞下来。',
    en: 'Hound flight, launch everything. Ram them if we have to.', voice: 'Hound flight, launch everything. Ram them if we have to.' },
  ],
  story_s01_s4_open_04: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧3，抵达。释放全部蜂群。',
    en: 'Anvil three, on station. Releasing all swarms.', voice: 'Anvil three, on station. Releasing all swarms.' },
  ],
  story_s01_s4_open_05: [
    { speaker: '蜂群控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '蜂群，自杀式攻击。目标，敌方战斗机。',
    en: 'Swarm, kamikaze attack. Target, enemy fighters.', voice: 'Swarm, kamikaze attack. Target, enemy fighters.' },
  ],
  story_s01_s4_open_06: [
    { speaker: '长矛备用', side: 'enemy', voiceSpeaker: 'enemy1', text: '长矛备用炮充能。连续发射。',
    en: 'Spare Lance charging. Continuous fire.', voice: 'Spare Lance charging. Continuous fire.' },
  ],
  story_s01_s4_open_07: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '核心稳定。护盾？没有护盾。靠你们了。',
    en: 'Core stable. Shields? There are no shields. It is on you.', voice: 'Core stable. Shields? There are no shields. It is on you.' },
  ],
  story_s01_s4_open_08: [
    { speaker: '堡垒火控', side: 'enemy', voiceSpeaker: 'enemy1', text: '所有刺猬炮位，自由开火。不要停。',
    en: 'All Hedgehog mounts, weapons free. Do not stop.', voice: 'All Hedgehog mounts, weapons free. Do not stop.' },
  ],
  // === S-01 剧情台词 · s4_loss ===
  story_s01_s4_loss_01: [
    { speaker: '猎犬9', side: 'enemy', voiceSpeaker: 'enemy2', text: '我被锁定了！无法摆脱！',
    en: 'I am locked up! Cannot shake it!', voice: 'I am locked up! Cannot shake it!' },
  ],
  story_s01_s4_loss_02: [
    { speaker: '猎犬8', side: 'enemy', voiceSpeaker: 'enemy2', text: '猎犬9，机动！释放干扰弹！',
    en: 'Hound nine, maneuver! Pop decoys!', voice: 'Hound nine, maneuver! Pop decoys!' },
  ],
  story_s01_s4_loss_03: [
    { speaker: '猎犬9', side: 'enemy', voiceSpeaker: 'enemy2', text: '太晚了——！',
    en: 'Too late...!', voice: 'Too late...!' },
  ],
  story_s01_s4_loss_04: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '猎犬9损失。剩余单位继续。',
    en: 'Hound nine lost. Remaining units continue.', voice: 'Hound nine lost. Remaining units continue.' },
  ],
  // === S-01 剧情台词 · s4_core ===
  story_s01_s4_core_01: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '核心模块1受损！重复，模块1受损！',
    en: 'Core module one damaged! I say again, module one damaged!', voice: 'Core module one damaged! I say again, module one damaged!' },
  ],
  story_s01_s4_core_02: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '别慌。核心还有三个模块。',
    en: 'Steady. The core still has three modules.', voice: 'Steady. The core still has three modules.' },
  ],
  story_s01_s4_core_03: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '模块1被毁！核心暴露增加！',
    en: 'Module one destroyed! Core exposure increasing!', voice: 'Module one destroyed! Core exposure increasing!' },
  ],
  story_s01_s4_core_04: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧3受损！左舷导弹失效！',
    en: 'Anvil three damaged! Port missiles offline!', voice: 'Anvil three damaged! Port missiles offline!' },
  ],
  story_s01_s4_core_05: [
    { speaker: '蜂群控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '蜂群损失60%。继续释放。',
    en: 'Swarm losses sixty percent. Continue release.', voice: 'Swarm losses sixty percent. Continue release.' },
  ],
  story_s01_s4_core_06: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '模块2被毁！我们撑不住了！',
    en: 'Module two destroyed! We cannot hold!', voice: 'Module two destroyed! We cannot hold!' },
  ],
  story_s01_s4_core_07: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '撑住。他们快没弹药了。',
    en: 'Hold. They are nearly out of ammunition.', voice: 'Hold. They are nearly out of ammunition.' },
  ],
  story_s01_s4_core_08: [
    { speaker: '猎犬10', side: 'enemy', voiceSpeaker: 'enemy2', text: '他们没有没弹药！他们还在打！',
    en: 'They are not out of ammunition! They are still firing!', voice: 'They are not out of ammunition! They are still firing!' },
  ],
  story_s01_s4_core_09: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '模块3被毁！核心即将失效！',
    en: 'Module three destroyed! Core failure imminent!', voice: 'Module three destroyed! Core failure imminent!' },
  ],
  story_s01_s4_core_10: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '所有单位，保护核心！重复，保护核心！',
    en: 'All units, protect the core! I say again, protect the core!', voice: 'All units, protect the core! I say again, protect the core!' },
  ],
  // === S-01 剧情台词 · s4_core2 ===
  story_s01_s4_core2_01: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '铁砧3核心被毁！要炸了！',
    en: 'Anvil three core is destroyed! She is going to blow!', voice: 'Anvil three core is destroyed! She is going to blow!' },
  ],
  story_s01_s4_core2_02: [
    { speaker: '铁砧3', side: 'enemy', voiceSpeaker: 'enemy2', text: '触地倒计时……4……3……',
    en: 'Impact countdown... four... three...', voice: 'Impact countdown... four... three...' },
  ],
  story_s01_s4_core2_03: [
    { speaker: '心脏控制', side: 'enemy', voiceSpeaker: 'enemy1', text: '模块4被毁！核心全毁！堡垒失去动力！',
    en: 'Module four destroyed! Core is gone! Bastion is losing power!', voice: 'Module four destroyed! Core is gone! Bastion is losing power!' },
  ],
  story_s01_s4_core2_04: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '……所有单位，弃舰。重复，弃舰。',
    en: '...All units, abandon ship. I say again, abandon ship.', voice: '...All units, abandon ship. I say again, abandon ship.' },
  ],
  // === S-01 剧情台词 · s5_fall ===
  story_s01_s5_fall_01: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '这里是堡垒……我们……还在滑……',
    en: 'This is Bastion... we... are still sliding...', voice: 'This is Bastion... we... are still sliding...' },
  ],
  story_s01_s5_fall_02: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '引擎熄火。高度下降。速度无法维持。',
    en: 'Engines are out. Altitude dropping. Cannot hold airspeed.', voice: 'Engines are out. Altitude dropping. Cannot hold airspeed.' },
  ],
  story_s01_s5_fall_03: [
    { speaker: '猎犬10', side: 'enemy', voiceSpeaker: 'enemy2', text: '堡垒在低头！高度下降！',
    en: 'Bastion nose is dropping! Losing altitude!', voice: 'Bastion nose is dropping! Losing altitude!' },
  ],
  story_s01_s5_fall_04: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '不要管我们。撤离。重复，撤离。',
    en: 'Do not worry about us. Evacuate. I say again, evacuate.', voice: 'Do not worry about us. Evacuate. I say again, evacuate.' },
  ],
  story_s01_s5_fall_05: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '触地倒计时……10……9……',
    en: 'Impact countdown... ten... nine...', voice: 'Impact countdown... ten... nine...' },
  ],
  story_s01_s5_fall_06: [
    { speaker: '猎犬10', side: 'enemy', voiceSpeaker: 'enemy2', text: '弹射！弹射！',
    en: 'Eject! Eject!', voice: 'Eject! Eject!' },
  ],
  story_s01_s5_fall_07: [
    { speaker: '堡垒舰长', side: 'enemy', voiceSpeaker: 'enemy1', text: '这是堡垒……最后通讯……我们……',
    en: 'This is Bastion... final transmission... we...', voice: 'This is Bastion... final transmission... we...' },
  ],
  // === S-01 剧情台词 · 我方/盟友 (第一关 · 空中战舰「堡垒」) ===
  // 与上面的敌方那组同构: 每行一个事件, 池里只有一条, 引擎按进度整组顺序播放
  // (见下方的 S01_ALLY_BLOCKS)。
  // 角色: 基石 = 攻击任务指挥官 / 穹顶 = 预警管制 / 游隼 = 刃翼领队(玩家的长机) /
  //       山雀 · 夜枭 = 刃翼僚机 / 长弓1 · 铁锤1 · 盾牌1 = 另三支编队长 /
  //       竖琴 = 电子战干扰机 / 哨兵 = 海上观察哨。
  // voiceSpeaker: 指挥控制类(基石/穹顶/竖琴/哨兵) = ally1, 飞行呼号 = ally2。
  // === S-01 我方台词 · s0_open (开场 / 遭遇) ===
  story_s01_ally_s0_open_01: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '所有单位，目标代号"堡垒"。第一波敌机接近中。自由交战。',
    en: 'All units, target codename Bastion. First wave of bandits closing in. Weapons free.', voice: 'All units, target codename Bastion. First wave of bandits closing in. Weapons free.' },
  ],
  story_s01_ally_s0_open_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '刃翼2，目视确认。那东西……真的在飞。',
    en: 'Blade Wing two, visual confirmed. That thing... it is really flying.', voice: 'Blade Wing two, visual confirmed. That thing... it is really flying.' },
  ],
  story_s01_ally_s0_open_03: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '那么大？怎么可能？它怎么飞起来的？',
    en: 'That big? How is that possible? How does it even fly?', voice: 'That big? How is that possible? How does it even fly?' },
  ],
  story_s01_ally_s0_open_04: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '……确认。空中战舰。长方体。全长约900。',
    en: '...Confirmed. Air warship. A rectangular block. Overall length about nine hundred.', voice: '...Confirmed. Air warship. A rectangular block. Overall length about nine hundred.' },
  ],
  story_s01_ally_s0_open_05: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，抵达战区。请求攻击航线。',
    en: 'Longbow flight on station. Requesting attack heading.', voice: 'Longbow flight on station. Requesting attack heading.' },
  ],
  story_s01_ally_s0_open_06: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，就位。从下方进入。',
    en: 'Hammer flight in position. Entering from below.', voice: 'Hammer flight in position. Entering from below.' },
  ],
  story_s01_ally_s0_open_07: [
    { speaker: '盾牌1', side: 'ally', voiceSpeaker: 'ally2', text: '盾牌队，掩护刃翼。别让他们被咬住。',
    en: 'Shield flight, cover Blade Wing. Do not let anyone get on their tail.', voice: 'Shield flight, cover Blade Wing. Do not let anyone get on their tail.' },
  ],
  story_s01_ally_s0_open_08: [
    { speaker: '竖琴', side: 'ally', voiceSpeaker: 'ally1', text: '竖琴，开始电子压制。敌方雷达会受到干扰。',
    en: 'Harp, beginning electronic suppression. Enemy radar will be jammed.', voice: 'Harp, beginning electronic suppression. Enemy radar will be jammed.' },
  ],
  story_s01_ally_s0_open_09: [
    { speaker: '哨兵', side: 'ally', voiceSpeaker: 'ally1', text: '哨兵报告，海面观测到巨大阴影。确认是目标。',
    en: 'Sentry reports, a huge shadow on the sea surface. Confirmed, it is the target.', voice: 'Sentry reports, a huge shadow on the sea surface. Confirmed, it is the target.' },
  ],
  story_s01_ally_s0_open_10: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，你们是主力。长弓、铁锤、盾牌，配合刃翼。',
    en: 'Blade Wing, you are the main effort. Longbow, Hammer, Shield, support Blade Wing.', voice: 'Blade Wing, you are the main effort. Longbow, Hammer, Shield, support Blade Wing.' },
  ],
  story_s01_ally_s0_open_11: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '不要被护航机拖住。主舰才是目标。',
    en: 'Do not get dragged into the escorts. The main ship is the target.', voice: 'Do not get dragged into the escorts. The main ship is the target.' },
  ],
  // === S-01 我方台词 · s1_open (阶段1: 初始防御) ===
  story_s01_ally_s1_open_01: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '确认主舰表面有武器挂点。机炮和导弹发射器，全部激活了。小心。',
    en: 'Confirm weapon mounts on the main ship surface. Guns and missile launchers, all active. Watch yourself.', voice: 'Confirm weapon mounts on the main ship surface. Guns and missile launchers, all active. Watch yourself.' },
  ],
  story_s01_ally_s1_open_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，优先摧毁武器挂点。把它的牙拔掉。',
    en: 'Blade Wing, destroy the weapon mounts first. Pull its teeth.', voice: 'Blade Wing, destroy the weapon mounts first. Pull its teeth.' },
  ],
  story_s01_ally_s1_open_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '收到。刃翼2，跟上。刃翼3、4，保持编队。',
    en: 'Copy. Blade Wing two, on me. Blade Wing three and four, hold formation.', voice: 'Copy. Blade Wing two, on me. Blade Wing three and four, hold formation.' },
  ],
  story_s01_ally_s1_open_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '全舰都是炮口！怎么打？这打不完吧？',
    en: 'The whole ship is gun muzzles! How do we fight that? We cannot kill all of it!', voice: 'The whole ship is gun muzzles! How do we fight that? We cannot kill all of it!' },
  ],
  story_s01_ally_s1_open_05: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '打导弹发射器。机炮威胁低。先打上表面。',
    en: 'Hit the missile launchers. The guns are the lesser threat. Start with the upper surface.', voice: 'Hit the missile launchers. The guns are the lesser threat. Start with the upper surface.' },
  ],
  story_s01_ally_s1_open_06: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，从上方进入。攻击上表面挂点。',
    en: 'Longbow flight, entering from above. Attacking the upper surface mounts.', voice: 'Longbow flight, entering from above. Attacking the upper surface mounts.' },
  ],
  story_s01_ally_s1_open_07: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，从下方进入。下表面交给我们。',
    en: 'Hammer flight entering from below. Leave the lower surface to us.', voice: 'Hammer flight entering from below. Leave the lower surface to us.' },
  ],
  story_s01_ally_s1_open_08: [
    { speaker: '盾牌1', side: 'ally', voiceSpeaker: 'ally2', text: '盾牌队，吸引护航机火力。刃翼，你们专心打主舰。',
    en: 'Shield flight will draw the escort fire. Blade Wing, you focus on the main ship.', voice: 'Shield flight will draw the escort fire. Blade Wing, you focus on the main ship.' },
  ],
  story_s01_ally_s1_open_09: [
    { speaker: '竖琴', side: 'ally', voiceSpeaker: 'ally1', text: '干扰已投放。他们锁定会变慢。但别依赖这个。',
    en: 'Jamming is up. Their locks will be slow. But do not count on it.', voice: 'Jamming is up. Their locks will be slow. But do not count on it.' },
  ],
  story_s01_ally_s1_open_10: [
    { speaker: '哨兵', side: 'ally', voiceSpeaker: 'ally1', text: '哨兵，没有对空能力。祝好运。',
    en: 'Sentry has no air defense capability. Good luck.', voice: 'Sentry has no air defense capability. Good luck.' },
  ],
  // === S-01 我方台词 · s1_first (击毁第一个部件) ===
  story_s01_ally_s1_first_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '一个！它没动！它根本不在乎！',
    en: 'One down! It did not even flinch! It does not care at all!', voice: 'One down! It did not even flinch! It does not care at all!' },
  ],
  story_s01_ally_s1_first_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它当然不在乎。它全身都是。继续打。',
    en: 'Of course it does not. It is covered in them. Keep hitting it.', voice: 'Of course it does not. It is covered in them. Keep hitting it.' },
  ],
  story_s01_ally_s1_first_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '确认击毁。下一个。',
    en: 'Kill confirmed. Next one.', voice: 'Kill confirmed. Next one.' },
  ],
  story_s01_ally_s1_first_04: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，击毁一个发射器。',
    en: 'Longbow flight, one launcher destroyed.', voice: 'Longbow flight, one launcher destroyed.' },
  ],
  story_s01_ally_s1_first_05: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，击毁一个机炮塔。',
    en: 'Hammer flight, one gun turret destroyed.', voice: 'Hammer flight, one gun turret destroyed.' },
  ],
  // === S-01 我方台词 · s1_half (击毁半数部件) ===
  story_s01_ally_s1_half_01: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '堡垒表面火力下降约50%。继续。',
    en: 'Bastion surface firepower down about fifty percent. Continue.', voice: 'Bastion surface firepower down about fifty percent. Continue.' },
  ],
  story_s01_ally_s1_half_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '不要放松。它还有备用部件。',
    en: 'Do not ease off. It still has spare components.', voice: 'Do not ease off. It still has spare components.' },
  ],
  story_s01_ally_s1_half_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它在加速。想跑。',
    en: 'It is accelerating. It wants to run.', voice: 'It is accelerating. It wants to run.' },
  ],
  story_s01_ally_s1_half_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队损失一架！重复，长弓队损失一架！',
    en: 'Longbow flight lost one! I say again, Longbow lost one!', voice: 'Longbow flight lost one! I say again, Longbow lost one!' },
  ],
  story_s01_ally_s1_half_05: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓2被击落！长弓队继续攻击！',
    en: 'Longbow two is down! Longbow flight continues the attack!', voice: 'Longbow two is down! Longbow flight continues the attack!' },
  ],
  story_s01_ally_s1_half_06: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，继续。别停。',
    en: 'Hammer flight, continue. Do not stop.', voice: 'Hammer flight, continue. Do not stop.' },
  ],
  // === S-01 我方台词 · s1_last (击毁最后一个部件) ===
  story_s01_ally_s1_last_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '最后一个！打完了！',
    en: 'Last one! That is all of them!', voice: 'Last one! That is all of them!' },
  ],
  story_s01_ally_s1_last_02: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '等等——它在刷新。表面挂点在重新装填。新的武器上来了。',
    en: 'Wait - it is regenerating. Surface mounts are reloading. New weapons are coming up.', voice: 'Wait - it is regenerating. Surface mounts are reloading. New weapons are coming up.' },
  ],
  story_s01_ally_s1_last_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它带了多少备用部件？',
    en: 'How many spare components does it carry?', voice: 'How many spare components does it carry?' },
  ],
  story_s01_ally_s1_last_04: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '……很多。',
    en: '...A lot.', voice: '...A lot.' },
  ],
  story_s01_ally_s1_last_05: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，准备第二阶段。不要松懈。',
    en: 'Blade Wing, prepare for stage two. Do not ease off.', voice: 'Blade Wing, prepare for stage two. Do not ease off.' },
  ],
  // === S-01 我方台词 · s2_open (阶段2: 强化防御) ===
  story_s01_ally_s2_open_01: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '敌机撤退了。新一批从主舰弹射。六架。',
    en: 'Enemy fighters are pulling back. A new batch is launching from the main ship. Six aircraft.', voice: 'Enemy fighters are pulling back. A new batch is launching from the main ship. Six aircraft.' },
  ],
  story_s01_ally_s2_open_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，继续攻击主舰。不要追敌机。重复，不要追。',
    en: 'Blade Wing, keep hitting the main ship. Do not chase the fighters. I say again, do not chase.', voice: 'Blade Wing, keep hitting the main ship. Do not chase the fighters. I say again, do not chase.' },
  ],
  story_s01_ally_s2_open_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '收到。刃翼2，跟我来。刃翼3、4，保持掩护。',
    en: 'Copy. Blade Wing two, on me. Blade Wing three and four, stay on cover.', voice: 'Copy. Blade Wing two, on me. Blade Wing three and four, stay on cover.' },
  ],
  story_s01_ally_s2_open_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '六架！比刚才多！还有完没完！',
    en: 'Six of them! More than before! Will it ever end!', voice: 'Six of them! More than before! Will it ever end!' },
  ],
  story_s01_ally_s2_open_05: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '别追。打主舰。',
    en: 'Do not chase. Hit the main ship.', voice: 'Do not chase. Hit the main ship.' },
  ],
  story_s01_ally_s2_open_06: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，掩护刃翼。我们损失了一架，但还能打。',
    en: 'Longbow flight, cover Blade Wing. We lost one, but we can still fight.', voice: 'Longbow flight, cover Blade Wing. We lost one, but we can still fight.' },
  ],
  story_s01_ally_s2_open_07: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，被锁定了！释放干扰弹！',
    en: 'Hammer flight is locked up! Popping decoys!', voice: 'Hammer flight is locked up! Popping decoys!' },
  ],
  story_s01_ally_s2_open_08: [
    { speaker: '盾牌1', side: 'ally', voiceSpeaker: 'ally2', text: '盾牌队，挡住敌机。刃翼，你们继续。',
    en: 'Shield flight, block the fighters. Blade Wing, keep going.', voice: 'Shield flight, block the fighters. Blade Wing, keep going.' },
  ],
  story_s01_ally_s2_open_09: [
    { speaker: '竖琴', side: 'ally', voiceSpeaker: 'ally1', text: '干扰弹对堡垒无效。它太多了。只能靠机动。',
    en: 'Decoys are useless against Bastion. There are too many. Maneuver is all you have.', voice: 'Decoys are useless against Bastion. There are too many. Maneuver is all you have.' },
  ],
  // === S-01 我方台词 · s2_half ===
  story_s01_ally_s2_half_01: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '堡垒速度提升至200。它想脱离战区。',
    en: 'Bastion speed up to two hundred. It wants to leave the combat zone.', voice: 'Bastion speed up to two hundred. It wants to leave the combat zone.' },
  ],
  story_s01_ally_s2_half_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '不能让它跑。所有单位，全力攻击。',
    en: 'It must not get away. All units, maximum attack.', voice: 'It must not get away. All units, maximum attack.' },
  ],
  story_s01_ally_s2_half_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它在转。大半径盘旋。它跑不掉。',
    en: 'It is turning. A wide radius orbit. It is not getting away.', voice: 'It is turning. A wide radius orbit. It is not getting away.' },
  ],
  story_s01_ally_s2_half_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '它在放干扰弹！我锁不住！',
    en: 'It is dropping decoys! I cannot hold a lock!', voice: 'It is dropping decoys! I cannot hold a lock!' },
  ],
  story_s01_ally_s2_half_05: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '用机炮打部件。别依赖导弹。',
    en: 'Use guns on the components. Do not rely on missiles.', voice: 'Use guns on the components. Do not rely on missiles.' },
  ],
  story_s01_ally_s2_half_06: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，损失两架！重复，损失两架！',
    en: 'Hammer flight lost two! I say again, lost two!', voice: 'Hammer flight lost two! I say again, lost two!' },
  ],
  // === S-01 我方台词 · s2_last ===
  story_s01_ally_s2_last_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '打完了！这次它还有什么？',
    en: 'That is all of them! What else does it have?', voice: 'That is all of them! What else does it have?' },
  ],
  story_s01_ally_s2_last_02: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '雷达捕捉到新信号。表面挂点在刷新——但这次不一样。',
    en: 'Radar has new contacts. Surface mounts are regenerating - but this time it is different.', voice: 'Radar has new contacts. Surface mounts are regenerating - but this time it is different.' },
  ],
  story_s01_ally_s2_last_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '激光。我看到了。四门。',
    en: 'Lasers. I see them. Four of them.', voice: 'Lasers. I see them. Four of them.' },
  ],
  story_s01_ally_s2_last_04: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '……激光炮。小心。',
    en: '...Laser cannons. Watch out.', voice: '...Laser cannons. Watch out.' },
  ],
  story_s01_ally_s2_last_05: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '所有单位，注意激光射界。不要走直线。',
    en: 'All units, mind the laser firing lines. Do not fly straight.', voice: 'All units, mind the laser firing lines. Do not fly straight.' },
  ],
  // === S-01 我方台词 · s3_open (阶段3: 激光与舰队) ===
  story_s01_ally_s3_open_01: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '地图边缘出现两个新信号。轻型空中战舰。它们在往这边飞。',
    en: 'Two new contacts at the edge of the map. Light air warships. They are heading this way.', voice: 'Two new contacts at the edge of the map. Light air warships. They are heading this way.' },
  ],
  story_s01_ally_s3_open_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，优先打激光炮。那东西能一瞬间蒸发你们。',
    en: 'Blade Wing, the laser cannons are priority. Those things will vaporize you in an instant.', voice: 'Blade Wing, the laser cannons are priority. Those things will vaporize you in an instant.' },
  ],
  story_s01_ally_s3_open_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '激光炮。四门。看到了。刃翼2，准备攻击。',
    en: 'Laser cannons. Four. Visual. Blade Wing two, ready to attack.', voice: 'Laser cannons. Four. Visual. Blade Wing two, ready to attack.' },
  ],
  story_s01_ally_s3_open_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '还有援军？！两艘轻型舰，每艘六个部件。打完才炸。',
    en: 'Reinforcements too?! Two light ships, six components each. They only blow when every one is gone.', voice: 'Reinforcements too?! Two light ships, six components each. They only blow when every one is gone.' },
  ],
  story_s01_ally_s3_open_05: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '先打激光。再打轻型舰。',
    en: 'Lasers first. Then the light ships.', voice: 'Lasers first. Then the light ships.' },
  ],
  story_s01_ally_s3_open_06: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，攻击轻型舰左舷。我们负责左边那艘。',
    en: 'Longbow flight, hit the port side of the light ship. We take the one on the left.', voice: 'Longbow flight, hit the port side of the light ship. We take the one on the left.' },
  ],
  story_s01_ally_s3_open_07: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，攻击右舷。右边那艘交给我们。',
    en: 'Hammer flight takes the starboard side. The one on the right is ours.', voice: 'Hammer flight takes the starboard side. The one on the right is ours.' },
  ],
  story_s01_ally_s3_open_08: [
    { speaker: '盾牌1', side: 'ally', voiceSpeaker: 'ally2', text: '盾牌队，掩护。别让无人机靠近刃翼。',
    en: 'Shield flight on cover. Do not let the drones near Blade Wing.', voice: 'Shield flight on cover. Do not let the drones near Blade Wing.' },
  ],
  story_s01_ally_s3_open_09: [
    { speaker: '竖琴', side: 'ally', voiceSpeaker: 'ally1', text: '无人机群来了。电子压制跟不上。你们要靠自己。',
    en: 'Drone swarm inbound. Jamming cannot keep up. You are on your own.', voice: 'Drone swarm inbound. Jamming cannot keep up. You are on your own.' },
  ],
  story_s01_ally_s3_open_10: [
    { speaker: '哨兵', side: 'ally', voiceSpeaker: 'ally1', text: '哨兵报告，轻型舰在释放无人机。数量很多。',
    en: 'Sentry reports, the light ships are releasing drones. Large numbers.', voice: 'Sentry reports, the light ships are releasing drones. Large numbers.' },
  ],
  // === S-01 我方台词 · s3_charge (激光充能时) ===
  story_s01_ally_s3_charge_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '它在充能！那个闪光——！',
    en: 'It is charging! That glow -!', voice: 'It is charging! That glow -!' },
  ],
  story_s01_ally_s3_charge_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '机动！别走直线！刃翼3，右转！',
    en: 'Maneuver! Do not fly straight! Blade Wing three, break right!', voice: 'Maneuver! Do not fly straight! Blade Wing three, break right!' },
  ],
  story_s01_ally_s3_charge_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '躲开了。它充能三秒，发射五秒。有窗口。',
    en: 'Cleared it. It charges three seconds and fires five. There is a window.', voice: 'Cleared it. It charges three seconds and fires five. There is a window.' },
  ],
  story_s01_ally_s3_charge_04: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '利用充能间隙攻击。不要贪。',
    en: 'Attack in the charging gaps. Do not get greedy.', voice: 'Attack in the charging gaps. Do not get greedy.' },
  ],
  // === S-01 我方台词 · s3_laser1 (击毁第一门激光炮) ===
  story_s01_ally_s3_laser1_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '一门激光炮没了！还有三门！',
    en: 'One laser cannon down! Three to go!', voice: 'One laser cannon down! Three to go!' },
  ],
  story_s01_ally_s3_laser1_02: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '轻型舰开始释放无人机群。注意后方。',
    en: 'The light ships are starting to release drone swarms. Watch your six.', voice: 'The light ships are starting to release drone swarms. Watch your six.' },
  ],
  story_s01_ally_s3_laser1_03: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '干得好。继续打下一门。',
    en: 'Good hit. Take the next one.', voice: 'Good hit. Take the next one.' },
  ],
  // === S-01 我方台词 · s3_anvil1 (第一艘轻型舰全部6个部件击毁) ===
  story_s01_ally_s3_anvil1_01: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '一艘轻型舰完了——它没炸。它在往下掉。',
    en: 'One light ship is finished - but it did not blow. It is going down.', voice: 'One light ship is finished - but it did not blow. It is going down.' },
  ],
  story_s01_ally_s3_anvil1_02: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '惯性。它还在滑。等着看。',
    en: 'Inertia. It is still sliding. Wait and see.', voice: 'Inertia. It is still sliding. Wait and see.' },
  ],
  story_s01_ally_s3_anvil1_03: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '触地了！大爆炸！好大的火球！',
    en: 'Impact! Huge explosion! What a fireball!', voice: 'Impact! Huge explosion! What a fireball!' },
  ],
  story_s01_ally_s3_anvil1_04: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，确认轻型舰坠毁。大爆炸。',
    en: 'Longbow flight confirms the light ship crashed. Big explosion.', voice: 'Longbow flight confirms the light ship crashed. Big explosion.' },
  ],
  // === S-01 我方台词 · s3_anvil2 (击毁第二艘轻型舰) ===
  story_s01_ally_s3_anvil2_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '第二艘也掉了！结束了！',
    en: 'The second one is down too! It is over!', voice: 'The second one is down too! It is over!' },
  ],
  story_s01_ally_s3_anvil2_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '不。主舰还在。它的激光炮还剩两门。继续。',
    en: 'Negative. The main ship is still up. Two laser cannons left. Continue.', voice: 'Negative. The main ship is still up. Two laser cannons left. Continue.' },
  ],
  story_s01_ally_s3_anvil2_03: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，还在攻击。损失三架，但还能打。',
    en: 'Hammer flight is still in the fight. Three lost, but we can still fly.', voice: 'Hammer flight is still in the fight. Three lost, but we can still fly.' },
  ],
  // === S-01 我方台词 · s3_lasers_clear (击毁全部4门激光炮) ===
  story_s01_ally_s3_lasers_clear_01: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '激光全清了。主舰在减速。',
    en: 'All lasers are cleared. The main ship is slowing.', voice: 'All lasers are cleared. The main ship is slowing.' },
  ],
  story_s01_ally_s3_lasers_clear_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '核心。我看到核心露出来了。',
    en: 'The core. I see the core exposed.', voice: 'The core. I see the core exposed.' },
  ],
  story_s01_ally_s3_lasers_clear_03: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '堡垒核心暴露。最后一波航空大队正在弹射。十架。',
    en: 'The Bastion core is exposed. The final air group is launching. Ten aircraft.', voice: 'The Bastion core is exposed. The final air group is launching. Ten aircraft.' },
  ],
  story_s01_ally_s3_lasers_clear_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '十架！它把所有家底都掏出来了！',
    en: 'Ten! It is throwing everything it has left!', voice: 'Ten! It is throwing everything it has left!' },
  ],
  story_s01_ally_s3_lasers_clear_05: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '刃翼队，准备最终攻击。核心是最后目标。',
    en: 'Blade Wing, prepare for the final attack. The core is the last target.', voice: 'Blade Wing, prepare for the final attack. The core is the last target.' },
  ],
  // === S-01 我方台词 · s4_open (阶段4: 最终核心) ===
  story_s01_ally_s4_open_01: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '核心有4个模块。每个模块需要4发MSL。打完核心，任务结束。',
    en: 'The core has four modules. Each module takes four missiles. Kill the core and the mission is over.', voice: 'The core has four modules. Each module takes four missiles. Kill the core and the mission is over.' },
  ],
  story_s01_ally_s4_open_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它开始齐射了。所有武器一起打。刃翼2，跟上。',
    en: 'It is salvo firing. Everything at once. Blade Wing two, on me.', voice: 'It is salvo firing. Everything at once. Blade Wing two, on me.' },
  ],
  story_s01_ally_s4_open_03: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '三艘轻型舰从西边来了！还有完没完！',
    en: 'Three light ships coming in from the west! Will it ever stop!', voice: 'Three light ships coming in from the west! Will it ever stop!' },
  ],
  story_s01_ally_s4_open_04: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '最后了。打完核心，全结束。',
    en: 'This is the last of it. Kill the core and it is all over.', voice: 'This is the last of it. Kill the core and it is all over.' },
  ],
  story_s01_ally_s4_open_05: [
    { speaker: '长弓1', side: 'ally', voiceSpeaker: 'ally2', text: '长弓队，损失惨重！只剩一架！但我们还能打！',
    en: 'Longbow flight is badly hurt! One aircraft left! But we can still fight!', voice: 'Longbow flight is badly hurt! One aircraft left! But we can still fight!' },
  ],
  story_s01_ally_s4_open_06: [
    { speaker: '铁锤1', side: 'ally', voiceSpeaker: 'ally2', text: '铁锤队，全灭！重复，全灭！铁锤1，弹射！',
    en: 'Hammer flight is wiped out! I say again, wiped out! Hammer one, ejecting!', voice: 'Hammer flight is wiped out! I say again, wiped out! Hammer one, ejecting!' },
  ],
  story_s01_ally_s4_open_07: [
    { speaker: '盾牌1', side: 'ally', voiceSpeaker: 'ally2', text: '盾牌队，还在。掩护刃翼。别管我们。',
    en: 'Shield flight is still here. Covering Blade Wing. Do not worry about us.', voice: 'Shield flight is still here. Covering Blade Wing. Do not worry about us.' },
  ],
  story_s01_ally_s4_open_08: [
    { speaker: '竖琴', side: 'ally', voiceSpeaker: 'ally1', text: '电子压制失效。他们太多了。竖琴退出战区。',
    en: 'Jamming is ineffective. There are too many of them. Harp is leaving the combat zone.', voice: 'Jamming is ineffective. There are too many of them. Harp is leaving the combat zone.' },
  ],
  story_s01_ally_s4_open_09: [
    { speaker: '哨兵', side: 'ally', voiceSpeaker: 'ally1', text: '哨兵，没有更多支援了。你们只能靠自己和刃翼队。',
    en: 'Sentry: there is no more support. You and Blade Wing are on your own.', voice: 'Sentry: there is no more support. You and Blade Wing are on your own.' },
  ],
  // === S-01 我方台词 · s4_core1 (击毁第一个核心模块) ===
  story_s01_ally_s4_core1_01: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '第一个模块！打掉了！',
    en: 'First module! It is down!', voice: 'First module! It is down!' },
  ],
  story_s01_ally_s4_core1_02: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '它在往下沉。速度在掉。',
    en: 'It is settling. Speed is dropping.', voice: 'It is settling. Speed is dropping.' },
  ],
  story_s01_ally_s4_core1_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '确认。核心暴露增加。继续。',
    en: 'Confirmed. Core exposure increasing. Continue.', voice: 'Confirmed. Core exposure increasing. Continue.' },
  ],
  story_s01_ally_s4_core1_04: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '不要停。还有三个。',
    en: 'Do not stop. Three more.', voice: 'Do not stop. Three more.' },
  ],
  // === S-01 我方台词 · s4_core2 (击毁第二个核心模块) ===
  story_s01_ally_s4_core2_01: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '第二个模块。还有两个。',
    en: 'Second module. Two left.', voice: 'Second module. Two left.' },
  ],
  story_s01_ally_s4_core2_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它在失速。高度在掉。',
    en: 'It is stalling. Altitude is dropping.', voice: 'It is stalling. Altitude is dropping.' },
  ],
  story_s01_ally_s4_core2_03: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '我中弹了！但还能飞！',
    en: 'I am hit! But I can still fly!', voice: 'I am hit! But I can still fly!' },
  ],
  // === S-01 我方台词 · s4_core3 (击毁第三个核心模块) ===
  story_s01_ally_s4_core3_01: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '第三个模块！它失速了。在掉高度。',
    en: 'Third module! It is stalling. Losing altitude.', voice: 'Third module! It is stalling. Losing altitude.' },
  ],
  story_s01_ally_s4_core3_02: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '最后一个模块。打掉它，堡垒就完了。',
    en: 'Last module. Kill it and Bastion is finished.', voice: 'Last module. Kill it and Bastion is finished.' },
  ],
  story_s01_ally_s4_core3_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '核心在发光。蓄力中。小心。',
    en: 'The core is glowing. It is building up. Watch it.', voice: 'The core is glowing. It is building up. Watch it.' },
  ],
  // === S-01 我方台词 · s4_core4 (击毁最后一个核心模块 => 大爆炸, 任务完成) ===
  story_s01_ally_s4_core4_01: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '打中了！核心全毁！',
    en: 'Hit! The core is gone!', voice: 'Hit! The core is gone!' },
  ],
  story_s01_ally_s4_core4_02: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '它在低头。在往下栽。',
    en: 'It is nosing down. It is going in.', voice: 'It is nosing down. It is going in.' },
  ],
  story_s01_ally_s4_core4_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '引擎在熄火。它在滑。大惯性。',
    en: 'Engines are flaming out. It is gliding. Massive inertia.', voice: 'Engines are flaming out. It is gliding. Massive inertia.' },
  ],
  story_s01_ally_s4_core4_04: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '触地了——！',
    en: 'Impact -!', voice: 'Impact -!' },
  ],
  story_s01_ally_s4_core4_05: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '堡垒坠毁。确认击毁。所有单位，返航。',
    en: 'Bastion has crashed. Kill confirmed. All units, return to base.', voice: 'Bastion has crashed. Kill confirmed. All units, return to base.' },
  ],
  story_s01_ally_s4_core4_06: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '……那东西飞了那么久。终于停了。',
    en: '...That thing flew for so long. It finally stopped.', voice: '...That thing flew for so long. It finally stopped.' },
  ],
  story_s01_ally_s4_core4_07: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '我们做到了。我们真的做到了。',
    en: 'We did it. We actually did it.', voice: 'We did it. We actually did it.' },
  ],
  story_s01_ally_s4_core4_08: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '任务完成。',
    en: 'Mission complete.', voice: 'Mission complete.' },
  ],
  // === S-01 我方台词 · s5_fall (坠落阶段) ===
  story_s01_ally_s5_fall_01: [
    { speaker: '游隼', side: 'ally', voiceSpeaker: 'ally2', text: '别靠近。它掉下去的时候有冲击波。',
    en: 'Stay clear. There will be a shock wave when it goes in.', voice: 'Stay clear. There will be a shock wave when it goes in.' },
  ],
  story_s01_ally_s5_fall_02: [
    { speaker: '山雀', side: 'ally', voiceSpeaker: 'ally2', text: '它还在滑……那么大一坨，滑了好远。',
    en: 'It is still sliding... that huge hulk, it is sliding so far.', voice: 'It is still sliding... that huge hulk, it is sliding so far.' },
  ],
  story_s01_ally_s5_fall_03: [
    { speaker: '夜枭', side: 'ally', voiceSpeaker: 'ally2', text: '结束了。它不会再飞了。',
    en: 'It is over. It will never fly again.', voice: 'It is over. It will never fly again.' },
  ],
  story_s01_ally_s5_fall_04: [
    { speaker: '穹顶', side: 'ally', voiceSpeaker: 'ally1', text: '堡垒信号消失。任务完成。',
    en: 'Bastion signal is gone. Mission complete.', voice: 'Bastion signal is gone. Mission complete.' },
  ],
  story_s01_ally_s5_fall_05: [
    { speaker: '基石', side: 'ally', voiceSpeaker: 'ally1', text: '所有单位，返航。干得好，刃翼队。',
    en: 'All units, RTB. Good work, Blade Wing.', voice: 'All units, RTB. Good work, Blade Wing.' },
  ],
  story_s01_ally_s5_fall_06: [
    { speaker: '哨兵', side: 'ally', voiceSpeaker: 'ally1', text: '哨兵确认，海面大爆炸。目标消失。',
    en: 'Sentry confirms, large explosion on the sea surface. Target is gone.', voice: 'Sentry confirms, large explosion on the sea surface. Target is gone.' },
  ],
  // === S-01 随机常规台词 · 堡垒管制 (4 个变体, 池内随机) ===
  // === 关卡内过场运镜台词槽(占位: 等填) === 填内容只改 text/en, 想配音再加 mp3 即可
  ['story_s01_cine_intro_01']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 01］待填写', en: '[CINEMATIC SLOT · 开场 01] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 01] TO BE WRITTEN' },
  ],
  ['story_s01_cine_intro_02']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 02］待填写', en: '[CINEMATIC SLOT · 开场 02] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 02] TO BE WRITTEN' },
  ],
  ['story_s01_cine_intro_03']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 03］待填写', en: '[CINEMATIC SLOT · 开场 03] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 03] TO BE WRITTEN' },
  ],
  ['story_s01_cine_intro_04']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 04］待填写', en: '[CINEMATIC SLOT · 开场 04] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 04] TO BE WRITTEN' },
  ],
  ['story_s01_cine_intro_05']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 05］待填写', en: '[CINEMATIC SLOT · 开场 05] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 05] TO BE WRITTEN' },
  ],
  ['story_s01_cine_intro_06']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·开场 06］待填写', en: '[CINEMATIC SLOT · 开场 06] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 开场 06] TO BE WRITTEN' },
  ],
  ['story_s01_cine_crash_01']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·坠落 01］待填写', en: '[CINEMATIC SLOT · 坠落 01] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 坠落 01] TO BE WRITTEN' },
  ],
  ['story_s01_cine_crash_02']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·坠落 02］待填写', en: '[CINEMATIC SLOT · 坠落 02] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 坠落 02] TO BE WRITTEN' },
  ],
  ['story_s01_cine_crash_03']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·坠落 03］待填写', en: '[CINEMATIC SLOT · 坠落 03] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 坠落 03] TO BE WRITTEN' },
  ],
  ['story_s01_cine_crash_04']: [
    { speaker: '旁白', side: 'awacs', voiceSpeaker: 'awacs', text: '［过场台词位·坠落 04］待填写', en: '[CINEMATIC SLOT · 坠落 04] TO BE WRITTEN', voice: '[CINEMATIC SLOT · 坠落 04] TO BE WRITTEN' },
  ],
  story_s01_rand_control: [
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '这里是堡垒。所有单位，保持队形。',
    en: 'This is Bastion. All units, hold formation.', voice: 'This is Bastion. All units, hold formation.' },
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '目标空域火力密度不足。增援已派出。',
    en: 'Fire density in the target airspace is insufficient. Reinforcements dispatched.', voice: 'Fire density in the target airspace is insufficient. Reinforcements dispatched.' },
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '轻型舰队，保持航线。不要追击。',
    en: 'Light flotilla, hold course. Do not pursue.', voice: 'Light flotilla, hold course. Do not pursue.' },
    { speaker: '堡垒管制', side: 'enemy', voiceSpeaker: 'enemy1', text: '表面挂点受损。备用部件准备。',
    en: 'Hull mount damaged. Prepare spare components.', voice: 'Hull mount damaged. Prepare spare components.' },
  ],
  // === 正式版剧情第一关: 简报台词 (per user request: 简报界面要有台词, 语音是占位符) ===
  // 由菜单的 3D 简报界面按顺序显示(见 S01_BRIEF / storyLineInfo); 语音不生成 => 只显示字幕。
  'story_s01_brief_01': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '这里是预警机·鹰。简报开始。',
    en: 'This is AWACS Eagle. Briefing begins.', voice: 'This is AWACS Eagle. Briefing begins.' },
  ],
  'story_s01_brief_02': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '目标: 敌方空中战舰「堡垒」。长度一点三公里, 六个面挂满武器。',
    en: 'Target: the enemy air warship Bastion. Thirteen hundred meters long, weapons on all six faces.', voice: 'Target: the enemy air warship Bastion. Thirteen hundred meters long, weapons on all six faces.' },
  ],
  'story_s01_brief_03': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '它会分阶段换装: 先是机炮与导弹, 然后是激光阵列, 最后露出四个核心模块。',
    en: 'It swaps its loadout in phases: guns and missiles first, then laser arrays, and finally four exposed core modules.', voice: 'It swaps its loadout in phases: guns and missiles first, then laser arrays, and finally four exposed core modules.' },
  ],
  'story_s01_brief_04': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '打完当前阶段的全部挂点, 它才会进入下一阶段。别浪费弹药。',
    en: 'Only when every hardpoint of the current phase is destroyed will it advance. Do not waste ordnance.', voice: 'Only when every hardpoint of the current phase is destroyed will it advance. Do not waste ordnance.' },
  ],
  'story_s01_brief_05': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '四个核心全毁, 这艘船才会掉下来。在那之前, 它不会。',
    en: 'The ship goes down only when all four cores are destroyed. Not before.', voice: 'The ship goes down only when all four cores are destroyed. Not before.' },
  ],
  'story_s01_brief_06': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '空域归你。别让护卫机咬住你的尾巴。',
    en: 'The airspace is yours. Do not let the escorts get on your tail.', voice: 'The airspace is yours. Do not let the escorts get on your tail.' },
  ],
  // === 简报加长: 军事目的 + 作战方法 (per user request) ===
  // 插入在既有 6 句之间播出(顺序见下方 S01_BRIEF 数组), 语气是作战简报官。
  // 每条按"一句一个意思"拆短(约 40-75 字), 因为简报界面一次只显示一句字幕,
  // 单句过长会变成一整屏文字并停留很久。
  //   07-09 为什么打(形势 / 威胁 / 命令与约束)
  //   10-11 我们有什么(力量 / 时限与弹药约束)
  //   12-14 交战顺序与威胁应对(护航队顺序 / 激光 / 蜂群)
  //   15-16 武器与编队分工(武器 / 僚机指令)
  //   17-18 收尾(核心坠落 / 撤离)
  'story_s01_brief_07': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '先说为什么打。堡垒是敌方新造的战略级空中战舰，全长一点三公里，挂满远程对舰导弹。',
    en: 'First, why we are here. Bastion is the enemy\'s new strategic air warship, thirteen hundred meters long and loaded with long-range anti-ship missiles.' },
  ],
  'story_s01_brief_08': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '它正贴着我国舰队防空圈外缘航行。一旦抵达发射阵位，航母编队和沿岸基地都会落进它的火力覆盖。',
    en: 'It is cruising along the outer edge of our fleet air defense ring. Once it reaches its launch station, the carrier group and the coastal bases fall under its fire.' },
  ],
  'story_s01_brief_09': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '联合司令部命令：在公海上空把它打掉。不能让它抵达发射线，残骸也不许落在港口。',
    en: 'Unified Command orders us to kill it over open water. It must not reach the launch line, and its wreckage must not fall on the port.' },
  ],
  'story_s01_brief_10': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '我们有什么：你和僚机，加一个战斗空中巡逻分队。拦截窗口只有几分钟。',
    en: 'What we have: you, your wingman, and one combat air patrol element. The intercept window is only minutes.' },
  ],
  'story_s01_brief_11': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '舰队防空圈在它后方四十海里，你们必须在外圈完成攻击。弹药有限，每一发都要打在挂点上。',
    en: 'The fleet defense ring sits forty nautical miles behind it, so the attack must be finished on the outer ring. Ordnance is limited; every round goes into a hardpoint.' },
  ],
  'story_s01_brief_12': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '交战顺序：先清猎犬、铁砧、长矛三支护航队，再按阶段打挂点。',
    en: 'Order of engagement: clear the Hound, Anvil, and Lance escort groups first, then work the hardpoints phase by phase.' },
  ],
  'story_s01_brief_13': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '激光阵列充能三秒、照射五秒。它充能的时候，脱离光轴。',
    en: 'The laser array charges for three seconds and fires for five. Leave the optical axis while it charges.' },
  ],
  'story_s01_brief_14': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '蜂群无人机是自杀式的。别跟它缠斗，拉出来再从远处打。',
    en: 'The swarm drones are kamikazes. Do not dogfight them: extend out and shoot them from range.' },
  ],
  'story_s01_brief_15': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '武器分配：导弹打挂点，抵近了用机炮补刀。',
    en: 'Weapons: missiles for the hardpoints, guns to finish what is left up close.' },
  ],
  'story_s01_brief_16': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '僚机听你的 1、2、3 号指令——接敌、掩护、归队。你被咬住的时候，掩护指令能救命。留够返航的油。',
    en: 'Your wingman answers orders one, two, three: engage, cover, rejoin. The cover order keeps you alive when something gets behind you. Keep fuel for the trip home.' },
  ],
  'story_s01_brief_17': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '四个核心全毁，它才会失去动力，之后是滑翔下坠。',
    en: 'Only when all four cores are destroyed does the ship lose power, and then it glides down.' },
  ],
  'story_s01_brief_18': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs',
    text: '确认它落进公海，再撤出空域返航。不要停在坠落区上空，那是九百米的残骸。',
    en: 'Confirm it goes into open water, then egress and return to base. Do not linger over the impact area. That is nine hundred meters of falling wreckage.' },
  ],
  // === 结算台词 ===
  'story_s01_debrief_01': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '堡垒坠海。任务完成。',
    en: 'Bastion is down in the sea. Mission complete.', voice: 'Bastion is down in the sea. Mission complete.' },
  ],
  'story_s01_debrief_02': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '战果确认中……干净利落。',
    en: 'Confirming battle damage... clean work.', voice: 'Confirming battle damage... clean work.' },
  ],
  'story_s01_debrief_03': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '撤出空域, 返航。油钱记你账上。',
    en: 'Egress the airspace and RTB. Fuel is on your tab.', voice: 'Egress the airspace and RTB. Fuel is on your tab.' },
  ],
  'story_s01_debrief_04': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '这只是第一关。后面还有更硬的东西等着你。',
    en: 'That was only mission one. Harder things are waiting.', voice: 'That was only mission one. Harder things are waiting.' },
  ],
  // === S-02 简报台词 (第二关 · 洞川撤退) ===
  // 按 missions.ts:s02.brief 的任务书内容展开, 并补"军事目的 / 怎么打"两段。
  // 播放顺序见下方 S02_BRIEF。说话人 = 穹顶(本关我方管制, 声线角色 awacs)。
  // === S-02 剧情台词 (第二关 · 洞川撤退) ===
  // 与 S-01 同构: 每行一个事件, 池里只有一条, 引擎按进度整组顺序播放(见下方 S02_BLOCKS)。
  // 角色: 穹顶 = 预警管制 / 西坎奥莱管制(剑锋管制) = 敌方管制 / 游隼 · 山雀 · 夜枭 = 鹫中队
  //       (游隼 = 领队, 山雀 = 鹫3, 夜枭 = 鹫2) / 长弓1 · 长弓2 = 东奥莱轰炸机队 /
  //       铁锤1 = 运输机长 / 敌机1..6 = 剑锋战斗机 / 隼1..3 = 西坎奥莱王牌中队 /
  //       旁白 · 基地广播 = 画外音。
  // voiceSpeaker: 管制/基地/旁白 = awacs; 敌机奇数呼号+隼1/隼3 = enemy1, 敌机偶数呼号+隼2 = enemy2;
  //       游隼/长弓1/铁锤1 = ally1, 山雀/夜枭/长弓2 = ally2(同一说话人全文件固定同一音色)。
  // 本轮语音为占位符: 不产出 mp3, 运行时优雅降级为「只显示字幕」(presentSubtitleOnly)。
  // === S-02 台词 · s0_open (11 句) ===
  // === S-02 台词 · s1_open (12 句) ===
  // === S-02 台词 · s2_open (18 句) ===
  // === S-02 台词 · s3_open (15 句) ===
  // === S-02 台词 · s4_open (20 句) ===
  // === S-02 台词 · s5_open (57 句) ===
  // === S-02 台词 · s6_open (20 句) ===
  // === S-02 台词 · s7_base (10 句) ===
  // === S-02 台词 · s8_hangar (16 句) ===
  // === S-02 最终版剧本增补台词 (§350 用户提供 · 新词 101 句) ===
  // 与既有池同构: 每行一个事件, 池里只有一条。这些 id 已按剧本行序插进下方 S02_BLOCKS;
  // 剧本里与既有台词重复的句子**不在这里**(复用既有 id), 所以 S02_BLOCKS 某些块里会出现
  // 别的块名的 id —— 那是同一句台词在两个阶段各播一次, 属于设计内(见 s2_open/s3_open)。
  // 语音仍为占位符: 不产出 mp3, 运行时只出字幕。
  // --- s0_open 新增 7 句 ---
  // --- s1_open 新增 12 句 ---
  // --- s2_open 新增 25 句 ---
  // --- s3_open 新增 8 句 ---
  // --- s4_open 新增 14 句 ---
  // --- s5_open 新增 14 句 ---
  // --- s6_open 新增 13 句 ---
  // --- s7_base 新增 8 句 ---
  story_s02_s0_open_01: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '我去我去！底下炸出来的真是钱啊！满天飞的都是万元钞！我刚看见一沓子飘我机翼上了！',
      en: 'Whoa whoa! That is money down there! Ten-thousand notes everywhere! One stack just flew past my wing!' },
  
  ],
  story_s02_s0_open_02: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '瞧你那点出息。这一炸，底下少说几十亿。咱们这趟双倍津贴，加起来还没人家零头多。',
      en: 'Look at you. That blast just vaporised billions. Our double bonus is pocket change next to it.' },
  
  ],
  story_s02_s0_open_03: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '几十亿？！咱们炸的不是军火库吗？',
      en: 'Billions?! I thought we were bombing an arms depot?' },
  
  ],
  story_s02_s0_open_04: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '军火库？军火库是给外面人听的。咱们真正的任务，就是炸人家钱库。',
      en: 'Arms depot? That is what the paperwork says. Our actual job was their vault.' },
  
  ],
  story_s02_s0_open_05: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '管他炸什么呢。炸完赶紧回去，我还约了人下班喝酒。',
      en: 'Whatever we hit. Let us wrap up — I have drinks booked after shift.' },
  
  ],
  story_s02_s0_open_06: [
    { speaker: '西瓜', side: 'ally', voiceSpeaker: 'ally2', text: '队长队长！真的是钱！我看见地下三层炸开，全是现金！还有金条！',
      en: 'Lead, lead! It is really cash! The third basement is blown wide open — bills and gold bars!' },
  
  ],
  story_s02_s0_open_07: [
    { speaker: '烟斗', side: 'ally', voiceSpeaker: 'ally1', text: '看见了就看见了，别嚷嚷。保密条例忘了？',
      en: 'You saw it, fine. Keep it to yourself. Remember the secrecy clause?' },
  
  ],
  story_s02_s0_open_08: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '防空炮火都挨了，就为了给人炸个钱包？这活儿我不接了！',
      en: 'Son of a — we flew through flak just so somebody could blow up a wallet?' },
  
  ],
  story_s02_s0_open_09: [
    { speaker: '尺子', side: 'ally', voiceSpeaker: 'ally2', text: '那、那咱们这算不算犯罪啊……',
      en: 'S-so does that make us criminals...?' },
  
  ],
  story_s02_s0_open_10: [
    { speaker: '药箱', side: 'ally', voiceSpeaker: 'ally2', text: '算。但给钱多。你不干有的是人干。',
      en: 'Yes. But it pays well. If you will not, someone else will.' },
  
  ],
  story_s02_s0_open_11: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我操我操我操！我的钱！我全部老婆本啊！三万啊！三万！',
      en: 'No no no no! My money! Everything I saved for a wife! Thirty thousand!' },
  
  ],
  story_s02_s0_open_12: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '我的年终奖！我熬了一整年的年终奖啊！说没就没了？',
      en: 'My year-end bonus! A whole year of overtime — gone just like that?' },
  
  ],
  story_s02_s0_open_13: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '妈的，敢砸老子的盘。追上去！打下来一架抽两成，老子今天要回本！',
      en: 'They smashed my stake. After them! Twenty percent a kill — I am breaking even today!' },
  
  ],
  story_s02_s0_open_14: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '我半年工资啊……我就想赚点化妆品钱……我保证金还在里面啊……',
      en: 'Half a year of pay... I only wanted makeup money... my deposit was in there...' },
  
  ],
  story_s02_s0_open_15: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '都闭嘴。全体追击。击落一架轰炸机，补个人损失10%。击落队长机，补30%。',
      en: 'Quiet. All units, pursue. Ten percent of personal losses per bomber down. Thirty for the lead.' },
  
  ],
  story_s02_s0_open_16: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '收到！这波打完我就能娶媳妇了！',
      en: 'Copy! After this run I can afford a wife!' },
  
  ],
  story_s02_s0_open_17: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '关东的你们是不是有病！打仗就打仗，你炸人银行？！',
      en: 'Are you Easterners sick?! Fight a war, fine — but you bombed a bank?!' },
  
  ],
  story_s02_s0_open_18: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '哟，这么急眼啊？你们开黑盘赚黑心钱的时候，怎么不说自己缺德啊？',
      en: 'Oh, touchy. When you were running that book of yours, did you call yourselves crooks?' },
  
  ],
  story_s02_s1_open_01: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '那、那是我们应得的！你们这是抢劫！',
      en: 'Th-that was ours by right! This is robbery!' },
  
  ],
  story_s02_s1_open_02: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '抢劫怎么了。我们老板给的多。',
      en: 'And? Our boss pays well.' },
  
  ],
  story_s02_s1_open_03: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们卑鄙！你们无耻！',
      en: 'You are despicable! Shameless!' },
  
  ],
  story_s02_s1_open_04: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '别光喊！有种就压上来打，没种就闭嘴跟着飞！',
      en: 'Shut it! Come up here and fight, or sit on it!' },
  
  ],
  story_s02_s1_open_05: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '行，你们嘴硬。等下打下来，让你们跳伞都带着欠条。',
      en: 'Fine, tough talk. When we drop you, you will bail out carrying an IOU.' },
  
  ],
  story_s02_s1_open_06: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '行了，都别废话了。想打的过来，不想打的回去算账。',
      en: 'Enough chatter. Come fight if you want, or go home and count your losses.' },
  
  ],
  story_s02_s1_open_07: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '好。咱们慢慢算。',
      en: 'Good. We will settle it slowly.' },
  
  ],
  story_s02_s1_open_08: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '家人们！名场面啊！公频骂起来了！史上第一次因为炸金库引发的空战！',
      en: 'Folks! A legendary moment! Open channel is on fire — the first air war started by a blown vault!' },
  
  ],
  story_s02_s1_open_09: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '最新赔率更新！关西追击成功1赔5，编队全身而退1赔2.5！',
      en: 'Odds update! West pursuit succeeds: five to one. Formation escapes intact: two and a half.' },
  
  ],
  story_s02_s1_open_10: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '我刚才看见有人押了十万关东输，现在已经在天台了啊！',
      en: 'Someone just put a hundred grand on the East losing. He is on the rooftop already!' },
  
  ],
  story_s02_s1_open_11: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '本场赛事由磐户军工独家赞助——磐户机载机炮，打钱准，打人更准！',
      en: 'Tonight sponsored by Iwado Arms — Iwado gun pods: accurate on coin, deadlier on target!' },
  
  ],
  story_s02_s1_open_12: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '我靠我靠！后面那个咬我尾了！老陈救我！',
      en: 'Whoa whoa! One is on my tail! Old Chen, help me out!' },
  
  ],
  story_s02_s1_open_13: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '救你可以啊。这趟津贴分我一半。',
      en: 'Sure I will. Half your bonus for this sortie.' },
  
  ],
  story_s02_s1_open_14: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '你抢劫啊！',
      en: 'That is robbery!' },
  
  ],
  story_s02_s1_open_15: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '别说了别说了！我这边也来一个！这小子疯了一样冲我！',
      en: 'Not now! I have one too — the kid is charging me like a madman!' },
  
  ],
  story_s02_s1_open_16: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '哎，别往我这边引啊。我只想安安静静混完这趟。',
      en: 'Hey, do not drag them my way. I just want a quiet shift.' },
  
  ],
  story_s02_s2_open_01: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '都别闹！二对一缠住他们，别让他们靠近轰炸机。',
      en: 'Knock it off! Two on one, tie them up — keep them off the bombers.' },
  
  ],
  story_s02_s2_open_02: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '真是的，拿双倍工资，干三倍的活。',
      en: 'Double pay, triple work. Typical.' },
  
  ],
  story_s02_s2_open_03: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '来啊！贴上来，看看谁先撑不住！',
      en: 'Come on! Get over here! I will shred your cockpit!' },
  
  ],
  story_s02_s2_open_04: [
    { speaker: '西瓜', side: 'ally', voiceSpeaker: 'ally2', text: '铁牛牛逼！哎哎左边！左边有一架绕过来了！',
      en: 'Attaboy! Hey — left, left! One is swinging around!' },
  
  ],
  story_s02_s2_open_05: [
    { speaker: '尺子', side: 'ally', voiceSpeaker: 'ally2', text: '队长，三号引擎中弹了！速度掉了十节！',
      en: 'Lead, engine three is hit! We lost ten knots!' },
  
  ],
  story_s02_s2_open_06: [
    { speaker: '烟斗', side: 'ally', voiceSpeaker: 'ally1', text: '稳住。护航队会挡住的。',
      en: 'Steady. The escorts will hold them.' },
  
  ],
  story_s02_s2_open_07: [
    { speaker: '药箱', side: 'ally', voiceSpeaker: 'ally2', text: '我们这边没事。伤员都稳着呢。你们前面加油。',
      en: 'We are fine back here. Wounded are stable. Good hunting up front.' },
  
  ],
  story_s02_s2_open_08: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '这小子滑不溜手，烦死了！',
      en: 'This one slips like a fish!' },
  
  ],
  story_s02_s2_open_09: [
    { speaker: '西瓜', side: 'ally', voiceSpeaker: 'ally2', text: '哎你们听公频，关西那边又吵起来了！',
      en: 'Hey, listen to the open channel — the West is arguing again!' },
  
  ],
  story_s02_s2_open_10: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '别跑！你给我站住！我的钱！',
      en: 'Do not run! Hold still! My money!' },
  
  ],
  story_s02_s2_open_11: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '你他妈喊什么喊！他能站住等你打？',
      en: 'Stop yelling! You think he will wait for you?' },
  
  ],
  story_s02_s2_open_12: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '不行了不行了，我这老飞机追不上了……我的年终奖啊……',
      en: 'I cannot keep up... this old crate is done... my bonus...' },
  
  ],
  story_s02_s2_open_13: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '我、我第一次打真仗……我手心全是汗……',
      en: 'Th-this is my first real fight... my hands are soaked...' },
  
  ],
  story_s02_s2_open_14: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '都集中精神！打下来什么都有！打不下来，你们今年全白干！',
      en: 'Focus! Bring them down and you get everything. Miss, and you worked this year for nothing!' },
  
  ],
  story_s02_s2_open_15: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我知道我知道！这波必须回本！',
      en: 'I know, I know! This run has to break even!' },
  
  ],
  story_s02_s2_open_16: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '你们关东的是不是男人！有本事停下来单挑！',
      en: 'Are you Easterners even men?! Stop and fight me one on one!' },
  
  ],
  story_s02_s2_open_17: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '有本事你追上来啊。追不上就别嚷嚷。',
      en: 'Catch up first. Then talk.' },
  
  ],
  story_s02_s2_open_18: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们耍赖！你们飞机比我们好！',
      en: 'You cheat! Your planes are better!' },
  
  ],
  story_s02_s2_open_19: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '废话。我们老板给钱多，飞机当然好。',
      en: 'Obviously. Our boss pays more, so our planes are better.' },
  
  ],
  story_s02_s2_open_20: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们太欺负人了……',
      en: 'You are all so unfair...' },
  
  ],
  story_s02_s2_open_21: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '欺负？这叫任务。要怪就怪你们老板给的钱少！',
      en: 'Unfair? So what. Should have been born richer!' },
  
  ],
  story_s02_s2_open_22: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '行，你们狂。等下你们中弹了，别喊救命。',
      en: 'Enjoy the bravado. When you are hit, do not scream for help.' },
  
  ],
  story_s02_s2_open_23: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '哎，你们到底亏了多少钱啊，这么拼命？',
      en: 'Hey — how much did you actually lose, to fight this hard?' },
  
  ],
  story_s02_s2_open_24: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我三万！',
      en: 'Thirty thousand!' },
  
  ],
  story_s02_s2_open_25: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '我八万！',
      en: 'Eighty thousand!' },
  
  ],
  story_s02_s2_open_26: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '我五万……',
      en: 'Fifty thousand...' },
  
  ],
  story_s02_s2_open_27: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '哈哈哈哈就这点钱？你们至于玩命吗？',
      en: 'Hahaha, that little? And you are betting your lives?' },
  
  ],
  story_s02_s2_open_28: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '那是你们老板赚得多。我们这点钱，就是命。',
      en: 'Your boss earns more. For us, that little is our life.' },
  
  ],
  story_s02_s2_open_29: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '太刺激了！一边追一边骂！这哪是空战啊，这是街头讨债啊！',
      en: 'Incredible! Chasing and shouting — this is not an air battle, this is debt collection!' },
  
  ],
  story_s02_s2_open_30: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '目前编队损失一架战机！赔率小幅波动！现在押"损失三架以内"1赔1.8！',
      en: 'One fighter lost so far! Odds shifting. "Three losses or fewer" now pays one point eight!' },
  
  ],
  story_s02_s2_open_31: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '关西加油啊！再打下来一架，赔率直接翻倍！',
      en: 'Come on, West! One more kill and the payout doubles!' },
  
  ],
  story_s02_s2_open_32: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '感谢玄坛军工赞助本场赛事——玄坛航空炸弹，炸得精准，亏得痛快！',
      en: 'Sponsored by Gendan Arms — Gendan aerial bombs: precise hits, painful losses!' },
  
  ],
  story_s02_s3_open_01: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '老陈、阿凯，带轰炸机先走！我和拓也、沈哥断后！',
      en: 'Chen, Kai — take the bombers out. Takuya, Shen and I hold the rear.' },
  
  ],
  story_s02_s3_open_02: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '队长……这断后，额外算钱不？',
      en: 'Lead... this rearguard — is that extra pay?' },
  
  ],
  story_s02_s3_open_03: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '算！三倍补贴！殉职了抚恤金翻倍！',
      en: 'Yes! Triple allowance. Double death benefit if it goes bad.' },
  
  ],
  story_s02_s3_open_04: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '收到！队长保重！',
      en: 'Copy! Take care, lead!' },
  
  ],
  story_s02_s3_open_05: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '不是吧真断后啊？我还没娶媳妇呢！',
      en: 'You are serious about the rearguard? I am not even married yet!' },
  
  ],
  story_s02_s3_open_06: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '得了，躲也躲不掉。打吧。',
      en: 'No point dodging it. Let us fight.' },
  
  ],
  story_s02_s3_open_07: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '队长……我还能活着回去领津贴不……',
      en: 'Lead... am I getting home to collect the allowance...?' },
  
  ],
  story_s02_s3_open_08: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '能。都撑住。撑到防空圈就赢了。',
      en: 'You will. Hold the line. Reach the defence zone and we win.' },
  
  ],
  story_s02_s3_open_09: [
    { speaker: '尺子', side: 'ally', voiceSpeaker: 'ally2', text: '队长，又掉了一架护航机……',
      en: 'Lead... another escort is gone...' },
  
  ],
  story_s02_s3_open_10: [
    { speaker: '烟斗', side: 'ally', voiceSpeaker: 'ally1', text: '别看。加速。我们活着回去，他们才不算白死。',
      en: 'Do not look. Throttle up. If we live, they did not die for nothing.' },
  
  ],
  story_s02_s3_open_11: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '……都是拿工资的，图什么呢。',
      en: '...Damn. We are all just on payroll. What is the point.' },
  
  ],
  story_s02_s3_open_12: [
    { speaker: '西瓜', side: 'ally', voiceSpeaker: 'ally2', text: '刚才还跟我贫嘴呢……这就没了……',
      en: 'He was joking with me a minute ago... and now he is gone...' },
  
  ],
  story_s02_s3_open_13: [
    { speaker: '药箱', side: 'ally', voiceSpeaker: 'ally2', text: '伤员都安静了。他们也在听。',
      en: 'The wounded have gone quiet. They are listening too.' },
  
  ],
  story_s02_s3_open_14: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我打中一架！我打中了！哈哈哈哈回本了！我回本了！',
      en: 'I got one! I hit him! Hahaha, I broke even! I broke even!' },
  
  ],
  story_s02_s3_open_15: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我操——！我刚回本啊——！',
      en: 'Oh no —! I just broke even —!' },
  
  ],
  story_s02_s3_open_16: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '明？明！……妈的，跟你们拼了！',
      en: 'Ming? Ming! ...To hell with it — I am taking you all with me!' },
  
  ],
  story_s02_s3_open_17: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '完了完了……钱没赚到，命差点没了……',
      en: 'That is it... no money, nearly no life...' },
  
  ],
  story_s02_s3_open_18: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '我不想打了……我想回家……我不要钱了……',
      en: 'I do not want to fight... I want to go home... keep the money...' },
  
  ],
  story_s02_s3_open_19: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '……继续追。还差一点。',
      en: '...Keep pursuing. We are close.' },
  
  ],
  story_s02_s3_open_20: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '知道了。',
      en: 'Understood.' },
  
  ],
  story_s02_s3_open_21: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '你们疯了！为了几万块钱玩命？',
      en: 'You are insane! Throwing your lives away for a few thousand?!' },
  
  ],
  story_s02_s3_open_22: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '几万块？那是老子全部家当！',
      en: 'A few thousand? That is everything I own!' },
  
  ],
  story_s02_s3_open_23: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '你们不会去打工吗……非要赌……',
      en: 'Why not just get a job... instead of gambling...' },
  
  ],
  story_s02_s3_open_24: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '打工？打工一年赚多少？赌一把，顶三年。',
      en: 'A job? A year of work pays what? One bet covers three years.' },
  
  ],
  story_s02_s3_open_25: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '哎，中弹了。',
      en: 'Ah. I am hit.' },
  
  ],
  story_s02_s3_open_26: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '各位，别赌了。真的会死人的。',
      en: 'Everyone — stop gambling. People really do die.' },
  
  ],
  story_s02_s3_open_27: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '沈哥……',
      en: 'Shen...' },
  
  ],
  story_s02_s3_open_28: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们现在退走，还来得及。',
      en: 'Withdraw now and it is not too late.' },
  
  ],
  story_s02_s3_open_29: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '退？退了回去没奖金。你当我们跟你们一样闲？',
      en: 'Withdraw? No bonus if we do. You think we have your leisure?' },
  
  ],
  story_s02_s3_open_30: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '又掉一架！又掉一架！双方都杀红了眼了！',
      en: 'Another one down! Another one! Both sides are seeing red!' },
  
  ],
  story_s02_s3_open_31: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '现在赔率已经冲到1赔12了！押关西翻盘的朋友，你们要发财了！',
      en: 'Odds just hit twelve to one! If you backed the West, you are getting rich!' },
  
  ],
  story_s02_s4_open_01: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '致敬每一位在战场上拼搏的勇士！你们是真正的斗士！',
      en: 'Salute to every warrior out there tonight! True fighters, all of you!' },
  
  ],
  story_s02_s4_open_02: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '本场赛事指定保险——平安寿险，战死赔双倍，赌输也有赔！',
      en: 'Official insurer: Ping An Life — double payout for the fallen, and gamblers get covered too!' },
  
  ],
  story_s02_s4_open_03: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '任务完成。返航。点名。',
      en: 'Mission complete. Heading home. Roll call.' },
  
  ],
  story_s02_s4_open_04: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '老陈，在。',
      en: 'Old Chen, here.' },
  
  ],
  story_s02_s4_open_05: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '阿凯……在。沈哥和拓也……',
      en: 'Kai... here. Shen and Takuya...' },
  
  ],
  story_s02_s4_open_06: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '知道了。回去给他们申请最高抚恤金。',
      en: 'Understood. I will file for the maximum death benefit.' },
  
  ],
  story_s02_s4_open_07: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '三倍补贴……加上抚恤金……他们俩比咱们赚得多。',
      en: 'Triple allowance plus death benefit... they are out-earning us.' },
  
  ],
  story_s02_s4_open_08: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '都什么时候了你还算这个！',
      en: 'Is that what you are thinking about right now?!' },
  
  ],
  story_s02_s4_open_09: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '不算怎么办。人都没了，总得落点钱吧。',
      en: 'What else? They are gone. Somebody should collect.' },
  
  ],
  story_s02_s4_open_10: [
    { speaker: '烟斗', side: 'ally', voiceSpeaker: 'ally1', text: '各机报伤亡。',
      en: 'All aircraft, report casualties.' },
  
  ],
  story_s02_s4_open_11: [
    { speaker: '尺子', side: 'ally', voiceSpeaker: 'ally2', text: '机枪手铁牛……中弹牺牲了。',
      en: 'Gunner Panghu... killed in action.' },
  
  ],
  story_s02_s4_open_12: [
    { speaker: '西瓜', side: 'ally', voiceSpeaker: 'ally2', text: '刚才还骂我呢……这就没了。',
      en: 'He was cursing me out a minute ago... and now he is gone.' },
  
  ],
  story_s02_s4_open_13: [
    { speaker: '烟斗', side: 'ally', voiceSpeaker: 'ally1', text: '回去吧。跟后勤说，多给他家里发点抚恤金。',
      en: 'Let us go home. Tell logistics to bump his family payout.' },
  
  ],
  story_s02_s4_open_14: [
    { speaker: '药箱', side: 'ally', voiceSpeaker: 'ally2', text: '我们这边伤员都没事。安全了。',
      en: 'Our wounded are all right. We are safe.' },
  
  ],
  story_s02_s4_open_15: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '……就这么算了？',
      en: '...So we just let it go?' },
  
  ],
  story_s02_s4_open_16: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '不然呢……冲过去也是死。钱没了，再没了命，更亏。',
      en: 'What else... pushing in means dying. Losing money is bad; losing money and your life is worse.' },
  
  ],
  story_s02_s4_open_17: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '算了？不可能。下次，炸他们的盘口。连本带利赚回来。',
      en: 'Let it go? Never. Next time we hit their book. Principal plus interest.' },
  
  ],
  story_s02_s4_open_18: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '回去报告老板。下个月，行动代号"讨债"。',
      en: 'Report to the boss. Next month, operation name: Debt Collection.' },
  
  ],
  story_s02_s4_open_19: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '……我钱还没要回来呢……',
      en: '...I still have not got my money back...' },
  
  ],
  story_s02_s4_open_20: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '闭嘴吧你！人活着就不错了！',
      en: 'Shut up! You are alive, that is enough!' },
  
  ],
  story_s02_s4_open_21: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '这次算你们赢。',
      en: 'This round is yours.' },
  
  ],
  story_s02_s4_open_22: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '谈不上赢。各为其主罢了。',
      en: 'Not a win. Just different employers.' },
  
  ],
  story_s02_s4_open_23: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '下次见面，就是我们讨债的时候。',
      en: 'Next time we meet, we come to collect.' },
  
  ],
  story_s02_s4_open_24: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '随时奉陪。只要你们老板给得起钱。',
      en: 'Any time. As long as your boss can pay.' },
  
  ],
  story_s02_s4_open_25: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们等着！我们迟早炸回来！',
      en: 'Just you wait! One day we bomb you back!' },
  
  ],
  story_s02_s4_open_26: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '行啊。先把你们自己的亏空填上再说吧。',
      en: 'Sure. Fill your own hole first.' },
  
  ],
  story_s02_s4_open_27: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '胜利！编队成功撤回防空圈！破晓行动圆满结束！',
      en: 'Victory! The formation is inside the defence zone! Operation Daybreak is a wrap!' },
  
  ],
  story_s02_s4_open_28: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '恭喜所有押中胜利的观众朋友们！今晚可以加餐了！',
      en: 'Congratulations to everyone who backed the winners! Extra rations tonight!' },
  
  ],
  story_s02_s4_open_29: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '明天同一时间，洞川战线反攻战！关西能不能复仇翻盘，我们拭目以待！',
      en: 'Same time tomorrow: the Dongchuan counter-offensive! Can the West avenge this? Stay tuned!' },
  
  ],
  story_s02_s4_open_30: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '感谢所有赞助商的大力支持！我们明天再见！',
      en: 'Thanks to all our sponsors! See you tomorrow!' },
  
  ],
  story_s02_s4_open_31: [
    { speaker: '参谋', side: 'ally', voiceSpeaker: 'ally1', text: '这次赚了多少？……三十亿？不错不错。抚恤金才几百万。',
      en: 'How much did we clear? ...Three billion? Very nice. Death benefits were a few million.' },
  
  ],
  story_s02_s4_open_32: [
    { speaker: '账本', side: 'enemy', voiceSpeaker: 'enemy1', text: '账全乱了……这得查到什么时候啊……',
      en: 'The books are a disaster... how long is this audit going to take...' },
  
  ],
  story_s02_s4_open_33: [
    { speaker: '扳手兵', side: 'ally', voiceSpeaker: 'ally2', text: '又大捷。哪次不是死一堆人，当官的升官发财。',
      en: 'Another great victory. Same as always: bodies for the ground crew, promotions for the brass.' },
  
  ],
  story_s02_s4_open_34: [
    { speaker: '新兵', side: 'enemy', voiceSpeaker: 'enemy2', text: '又要加班造炮弹……什么时候是个头啊。',
      en: 'Overtime making shells again... when does it end.' },
  
  ],
  story_s02_s4_open_35: [
    { speaker: '库管', side: 'ally', voiceSpeaker: 'ally2', text: '三倍补贴……又要多掏一笔钱。唉。',
      en: 'Triple allowance... another hole in the budget. Ugh.' },
  
  ],
  story_s02_s4_open_36: [
    { speaker: '新兵', side: 'enemy', voiceSpeaker: 'enemy2', text: '老板亏几十亿都不心疼，老子亏几万就要玩命。',
      en: 'The boss loses billions like it is nothing. I lose a few thousand and it costs my life.' },
  
  ],
  story_s02_s5_open_01: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '喂喂喂，关西的还在吗？别是跑了吧？',
      en: 'Hey, West — still there? Or did you run?' },
  
  ],
  story_s02_s5_open_02: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '跑？我们等着收你们的欠条呢。',
      en: 'Run? We are waiting to collect your IOUs.' },
  
  ],
  story_s02_s5_open_03: [
    { speaker: '算盘', side: 'ally', voiceSpeaker: 'ally1', text: '你们那点保证金还够赔几架飞机啊？',
      en: 'How many more airframes can your margin cover?' },
  
  ],
  story_s02_s5_open_04: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '关你屁事！反正比你们老板良心！',
      en: 'None of your business! At least our boss has a conscience!' },
  
  ],
  story_s02_s5_open_05: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '良心？赌上性命的人跟我谈良心？',
      en: 'Conscience? You gamble with your lives and talk about conscience?' },
  
  ],
  story_s02_s5_open_06: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '至少我们是自己的钱……',
      en: 'At least it is our own money...' },
  
  ],
  story_s02_s5_open_07: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '自己的钱亏得最快，你们不懂？',
      en: 'Your own money is the fastest to lose. Did nobody tell you?' },
  
  ],
  story_s02_s5_open_08: [
    { speaker: '账房', side: 'enemy', voiceSpeaker: 'enemy1', text: '别跟他们废话。省点力气追。',
      en: 'Stop wasting breath on them. Save it for the pursuit.' },
  
  ],
  story_s02_s5_open_09: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '听见没，人家老板在省油钱。',
      en: 'Hear that? Their boss is counting fuel.' },
  
  ],
  story_s02_s5_open_10: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '哎，你们谁开的是改装机？我们这边赌你三分钟内掉。',
      en: 'Hey, who flies the hot-rod? We are taking bets you drop within three minutes.' },
  
  ],
  story_s02_s5_open_11: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '开改装的怎么了？至少我的提成自己算。',
      en: 'So what if it is modified? At least I count my own cut.' },
  
  ],
  story_s02_s5_open_12: [
    { speaker: '咸鱼', side: 'ally', voiceSpeaker: 'ally2', text: '都别吵了，吵得我头疼……',
      en: 'Enough shouting. It is giving me a headache...' },
  
  ],
  story_s02_s5_open_13: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '哎，你们那边还剩几个能打的？报个数，我们好下注。',
      en: 'Hey, how many of you can still fight? Call it out — we want a number to bet on.' },
  
  ],
  story_s02_s5_open_14: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '报你个头。等下你们掉下来，我们自己数。',
      en: 'Call it out? When you go down we will do the counting.' },
  
  ],
  story_s02_s5_open_15: [
    { speaker: '尺子', side: 'ally', voiceSpeaker: 'ally2', text: '那个……能不能先给我换顶头盔？这顶看着是别人用过的。',
      en: 'Uh... could I get a different helmet first? This one clearly belonged to someone else.' },
  
  ],
  story_s02_s5_open_16: [
    { speaker: '翼人', side: 'enemy', voiceSpeaker: 'enemy1', text: '你们别打我们队长……他人其实挺好的……',
      en: 'Please do not shoot our lead... he is actually a decent person...' },
  
  ],
  story_s02_s5_open_17: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '赔率又动了！现在押"编队全员生还"1赔3.2，押"再掉两架"1赔2.1！',
      en: 'Odds moved again! "Everyone survives" pays three point two, "two more losses" pays two point one!' },
  
  ],
  story_s02_s5_open_18: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '本场赛事特别鸣谢: 磐户军工、玄坛军工、平安寿险——战场上多一个朋友，就少一条命。',
      en: 'Special thanks to Iwado Arms, Gendan Arms and Ping An Life — one more friend on the field, one less life lost.' },
  
  ],
  story_s02_s5_open_19: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '导播切一下关西的座舱——哎呀，这位朋友眼眶红了啊！',
      en: 'Cut to a West cockpit — oh, look at those eyes, somebody is tearing up!' },
  
  ],
  story_s02_s5_open_20: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '观众朋友们，现在每分钟都有几十万上下，别走开，广告之后更精彩！',
      en: 'Folks, fortunes are changing by the minute — stay with us, more after the break!' },
  
  ],
  story_s02_s5_open_21: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '有人问这算不算战争罪？我们把这个问题交给赞助商来回答。',
      en: 'Someone asks if this counts as a war crime. We will let the sponsors answer that one.' },
  
  ],
  story_s02_s5_open_22: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '现在场上还剩多少架？导播说他也数不过来！',
      en: 'How many are still flying? Our director says he lost count too!' },
  
  ],
  story_s02_s5_open_23: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '押注通道还有九十秒关闭！想翻本的朋友，抓紧！',
      en: 'Betting closes in ninety seconds! If you want it back, move!' },
  
  ],
  story_s02_s5_open_24: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '这是一场没有输家的比赛——除了两边飞行员。',
      en: 'A match with no losers tonight — except the pilots.' },
  
  ],
  story_s02_s5_open_25: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '导播说前面那架已经在冒烟了！观众朋友们，屏住呼吸！',
      en: 'Our director says that one up front is already smoking! Hold your breath, folks!' },
  
  ],
  story_s02_s5_open_26: [
    { speaker: '喇叭', side: 'awacs', voiceSpeaker: 'awacs', text: '有观众问奖金怎么领？请到后台窗口，凭击落编号办理。',
      en: 'A viewer asks how to claim his winnings? Back office window, bring your kill number.' },
  
  ],
  story_s02_s5_open_27: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '我的提成——！',
      en: 'My commission —!' },
  
  ],
  story_s02_s5_open_28: [
    { speaker: '扳手', side: 'ally', voiceSpeaker: 'ally2', text: '早知道……就不贪这加班费了……',
      en: 'If I had known... I would have skipped the overtime pay...' },
  
  ],
  story_s02_s5_open_29: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '我的房贷……还没还清啊……',
      en: 'My mortgage... still not paid off...' },
  
  ],
  story_s02_s5_open_30: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '这下……不用交税了。',
      en: 'Well... no more taxes at least.' },
  
  ],
  story_s02_s5_open_31: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '老板亏几十亿都没事，老子亏几万就要死……',
      en: 'The boss loses billions and shrugs. I lose a few thousand and die...' },
  
  ],
  story_s02_s5_open_32: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '也好……总算不用再排班了。',
      en: 'Fine... no more work shifts.' },
  
  ],
  story_s02_s5_open_33: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '……收到。你的位置，我记下了。',
      en: '...Copy. I have your position noted.' },
  
  ],
  story_s02_s5_open_34: [
    { speaker: '参谋', side: 'ally', voiceSpeaker: 'ally1', text: '这个月的战果报表我看了，死的人比赚的零头还便宜。',
      en: 'I read the monthly report. The dead cost less than the rounding error.' },
  
  ],
  story_s02_s5_open_35: [
    { speaker: '账本', side: 'enemy', voiceSpeaker: 'enemy1', text: '又得做两套账……一套给上面，一套给我们自己看。',
      en: 'Two sets of books again... one for the brass, one for us.' },
  
  ],
  story_s02_s5_open_36: [
    { speaker: '扳手兵', side: 'ally', voiceSpeaker: 'ally2', text: '飞机回来一架修一架，人也一样。',
      en: 'Planes come back one at a time and get patched. So do people.' },
  
  ],
  story_s02_s5_open_37: [
    { speaker: '库管', side: 'ally', voiceSpeaker: 'ally2', text: '补贴一发，这个季度的库房钱就没了。',
      en: 'One allowance run and the quarterly warehouse budget is gone.' },
  
  ],
  story_s02_s5_open_38: [
    { speaker: '新兵', side: 'enemy', voiceSpeaker: 'enemy2', text: '新闻里说我们是英雄。英雄怎么还不给加班费。',
      en: 'The news calls us heroes. Heroes still do not get overtime.' },
  
  ],
  story_s02_s5_open_39: [
    { speaker: '参谋', side: 'ally', voiceSpeaker: 'ally1', text: '下一场报价已经出来了。比这场高两成。',
      en: 'Next contract is already quoted. Twenty percent higher than this one.' },
  
  ],
  story_s02_s5_open_40: [
    { speaker: '扳手兵', side: 'ally', voiceSpeaker: 'ally2', text: '这批弹壳回收还能卖钱，别当垃圾倒了。',
      en: 'These spent casings still fetch scrap money. Do not bin them.' },
  
  ],
  story_s02_s5_open_41: [
    { speaker: '隼1', side: 'enemy', voiceSpeaker: 'enemy1', text: '鹫中队，久仰。我们是隼。你们炸的那座金库，是我们老板的。',
      en: 'Vulture flight, we have heard of you. We are Hayabusa. That vault you hit belonged to our employer.' },
  ],
  story_s02_s5_open_42: [
    { speaker: '隼1', side: 'enemy', voiceSpeaker: 'enemy1', text: '三号僚机(山雀)交给我。你们谁都别管他。',
      en: 'The number three — Chickadee — is mine. Nobody interfere.' },
  ],
  story_s02_s5_open_43: [
    { speaker: '隼2', side: 'enemy', voiceSpeaker: 'enemy2', text: '队长，我看他们护航队挺像样。要不要先打个招呼？',
      en: 'Lead, their escorts look decent. Shall we say hello first?' },
  ],
  story_s02_s5_open_44: [
    { speaker: '隼3', side: 'enemy', voiceSpeaker: 'enemy1', text: '招呼什么？直接咬住那架掉队的运输机。',
      en: 'Why bother. Just clamp onto that straggling transport.' },
  ],
  story_s02_s5_open_45: [
    { speaker: '三万', side: 'enemy', voiceSpeaker: 'enemy2', text: '隼中队来了！这下他们完了！我押的赔率要翻倍了！',
      en: 'Hayabusa is in! They are finished! My odds are doubling!' },
  ],
  story_s02_s5_open_46: [
    { speaker: '两成', side: 'enemy', voiceSpeaker: 'enemy2', text: '别高兴太早，先看他们能不能撑过五分钟。',
      en: 'Do not celebrate yet. Let us see if they last five minutes.' },
  ],
  story_s02_s5_open_47: [
    { speaker: '隼1', side: 'enemy', voiceSpeaker: 'enemy1', text: '关西的朋友，闭嘴。你们把行情做坏了，我们还得替你们擦屁股。',
      en: 'West friends, quiet. You wrecked the market and we clean up after you.' },
  ],
  story_s02_s5_open_48: [
    { speaker: '年终', side: 'enemy', voiceSpeaker: 'enemy1', text: '……连隼中队都这么说话。这仗到底给谁打的啊。',
      en: '...Even Hayabusa talks like that. Whose war is this anyway.' },
  ],
  story_s02_s5_open_49: [
    { speaker: '隼2', side: 'enemy', voiceSpeaker: 'enemy2', text: '别管那些。编队护航机，出来单挑。',
      en: 'Ignore them. Escort fighters — come out and dance.' },
  ],
  story_s02_s5_open_50: [
    { speaker: '落锤', side: 'ally', voiceSpeaker: 'ally1', text: '隼中队，你们的王牌是拿命换的。我的人拿的是工资。',
      en: 'Hayabusa, your ace status is paid in lives. My people are paid in salary.' },
  ],
  story_s02_s5_open_51: [
    { speaker: '隼1', side: 'enemy', voiceSpeaker: 'enemy1', text: '工资？那你们更该走。死了可没人给你们发抚恤金。',
      en: 'Salary? Then you should leave. Nobody pays death benefits for hired guns.' },
  ],
  story_s02_s5_open_52: [
    { speaker: '话匣', side: 'ally', voiceSpeaker: 'ally2', text: '哎，这话说得跟真的一样。你们老板给你发多少钱啊？',
      en: 'Hey, that sounded almost sincere. How much does your boss pay you?' },
  ],
  story_s02_s5_open_53: [
    { speaker: '隼3', side: 'enemy', voiceSpeaker: 'enemy1', text: '闭嘴，杂鱼。',
      en: 'Shut up, small fry.' },
  ],
  story_s02_s5_open_54: [
    { speaker: '铁牛', side: 'ally', voiceSpeaker: 'ally1', text: '哈！说我们是杂鱼？来啊，看谁先掉下去！',
      en: 'Hah! We are small fry now! Come on, let us see who drops first!' },
  ],
  story_s02_s5_open_55: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '这里是铁砧。护航机在我射界里。装填完毕。',
      en: 'This is Anvil. Escorts are inside my firing arc. Loaded.' },
  ],
  story_s02_s5_open_56: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '一发空爆弹，三秒后落点。跑吧。',
      en: 'One airburst, impact in three seconds. Run.' },
  ],
  story_s02_s5_open_57: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '想靠机动躲？我的弹是算好的。',
      en: 'Try dodging? The shell is already solved.' },
  ],
  story_s02_s5_open_58: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '你们的机体比你们值钱。别浪费。',
      en: 'Your airframes are worth more than you are. Do not waste them.' },
  ],
  story_s02_s5_open_59: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '我船体受损，射击效率下降。请求护航。',
      en: 'Hull damaged, fire rate degraded. Requesting cover.' },
  ],
  story_s02_s5_open_60: [
    { speaker: '铁砧', side: 'enemy', voiceSpeaker: 'enemy2', text: '本舰弃守。这片天交给隼中队。祝各位好运。',
      en: 'Abandoning station. The sky is Hayabusa\'s. Good luck to you all.' },
  ],
  story_s02_s5_open_61: [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs', text: '空爆弹出膛，三秒后到达。立刻离开锁定位置！',
      en: 'Airburst away. Impact in three. Get off the lock now!' },
  ],
  story_s02_s5_open_62: [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs', text: '两秒。',
      en: 'Two.' },
  ],
  story_s02_s5_open_63: [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs', text: '一秒。',
      en: 'One.' },
  ],
  story_s02_s5_open_64: [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs', text: '命中。鹫中队，检查损伤。',
      en: 'Impact. Vulture flight, check damage.' },
  ],
  story_s02_s5_open_65: [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs', text: '脱离成功，弹着点空了。干得漂亮。',
      en: 'Clean break, impact zone empty. Good flying.' },
  ],
  story_s02_s5_open_66: [
  
  ],
  story_s02_s5_open_67: [
  
  ],
  story_s02_s5_open_68: [
  
  ],
  story_s02_s5_open_69: [
  
  ],
  story_s02_s5_open_70: [
  
  ],
  story_s02_s5_open_71: [
  
  ],
  story_s02_s6_open_01: [
  
  ],
  story_s02_s6_open_02: [
  
  ],
  story_s02_s6_open_03: [
  
  ],
  story_s02_s6_open_04: [
  
  ],
  story_s02_s6_open_05: [
  
  ],
  story_s02_s6_open_06: [
  
  ],
  story_s02_s6_open_07: [
  
  ],
  story_s02_s6_open_08: [
  
  ],
  story_s02_s6_open_09: [
  
  ],
  story_s02_s6_open_10: [
  
  ],
  story_s02_s6_open_11: [
  
  ],
  story_s02_s6_open_12: [
  
  ],
  story_s02_s6_open_13: [
  
  ],
  story_s02_s6_open_14: [
  
  ],
  story_s02_s6_open_15: [
  
  ],
  story_s02_s6_open_16: [
  
  ],
  story_s02_s6_open_17: [
  
  ],
  story_s02_s6_open_18: [
  
  ],
  story_s02_s6_open_19: [
  
  ],
  story_s02_s6_open_20: [
  
  ],
  story_s02_s6_open_21: [
  
  ],
  story_s02_s6_open_22: [
  
  ],
  story_s02_s6_open_23: [
  
  ],
  story_s02_s6_open_24: [
  
  ],
  story_s02_s6_open_25: [
  
  ],
  story_s02_s6_open_26: [
  
  ],
  story_s02_s6_open_27: [
  
  ],
  story_s02_s6_open_28: [
  
  ],
  story_s02_s6_open_29: [
  
  ],
  story_s02_s6_open_30: [
  
  ],
  story_s02_s6_open_31: [
  
  ],
  story_s02_s7_base_01: [
  
  ],
  story_s02_s7_base_02: [
  
  ],
  story_s02_s7_base_03: [
  
  ],
  story_s02_s7_base_04: [
  
  ],
  story_s02_s7_base_05: [
  
  ],
  story_s02_s7_base_06: [
  
  ],
  story_s02_s7_base_07: [
  
  ],
  story_s02_s7_base_08: [
  
  ],
  story_s02_s7_base_09: [
  
  ],
  story_s02_s7_base_10: [
  
  ],
  story_s02_s7_base_11: [
  
  ],
  story_s02_s7_base_12: [
  
  ],
  story_s02_s7_base_13: [
  
  ],
  story_s02_s7_base_14: [
  
  ],
  story_s02_s7_base_15: [
  
  ],
  story_s02_s7_base_16: [
  
  ],
  story_s02_s7_base_17: [
  
  ],
  story_s02_s7_base_18: [
  
  ],
  story_s02_s8_hangar_01: [
  
  ],
  story_s02_s8_hangar_02: [
  
  ],
  story_s02_s8_hangar_03: [
  
  ],
  story_s02_s8_hangar_04: [
  
  ],
  story_s02_s8_hangar_05: [
  
  ],
  story_s02_s8_hangar_06: [
  
  ],
  story_s02_s8_hangar_07: [
  
  ],
  story_s02_s8_hangar_08: [
  
  ],
  story_s02_s8_hangar_09: [
  
  ],
  story_s02_s8_hangar_10: [
  
  ],
  'story_s02_brief_01': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '鹫中队，这里是穹顶。作战简报开始。',
    en: 'Vulture flight, this is Dome. Briefing begins.' },
  ],
  'story_s02_brief_02': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '先说任务。东奥莱对洞川的空袭已经结束，但出击编队受损。合同命令：把它们全部护回东奥莱西南防空圈。',
    en: 'First, the mission. The East Olay strike on Dongchuan is over, but the formation is damaged. Contract order: bring every one of them back inside the East Olay southwest air defense ring.' },
  ],
  'story_s02_brief_03': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '护航对象五架：长弓的轰炸机三架，铁锤的运输机两架。全部进圈，任务才算完成。',
    en: 'Five aircraft to protect: three Longbow bombers and two Hammer transports. The mission is complete only when all five are inside the ring.' },
  ],
  'story_s02_brief_04': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '编队已经受损：长弓3 引擎冒烟、速度受限；铁锤的运输机里载着伤员。谁掉队都不能丢。',
    en: 'The formation is already hurt: Longbow three is smoking and speed-restricted, and the Hammer transports are carrying wounded. Nobody gets left behind.' },
  ],
  'story_s02_brief_05': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '敌情：西坎奥莱「剑锋」中队会分三波压上来——东北、正东、东南。他们的目标不是你们，是编队。',
    en: 'Enemy: Xikan Olay\'s Saber squadron will come at you in three waves, from the northeast, due east, and southeast. Their target is not you. It is the formation.' },
  ],
  'story_s02_brief_06': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '怎么打：编队进圈之前不要追出去。打咬编队的，摆脱咬你的。',
    en: 'How we fight it: do not chase anyone outside the ring before the formation is in. Hit whoever is on the formation, and shake whoever is on you.' },
  ],
  'story_s02_brief_07': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '时间很紧。从进入走廊到编队入圈，不到二十五分钟。别在东奥莱防区外面耗。',
    en: 'Time is tight. From entering the corridor to the formation reaching the ring, you have under twenty-five minutes. Do not burn it outside the East Olay defense zone.' },
  ],
  'story_s02_brief_08': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '最后挡在返航路上的，是王牌中队「隼」——三架苏-35，技术很好。别单独接战。',
    en: 'What will be waiting on the way home is the ace squadron, Falcon: three Su-35s, very good pilots. Do not take them alone.' },
  ],
  'story_s02_brief_09': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '东侧有一艘中型空中战舰在巡逻，每五十秒一发空爆弹。它锁的是你那一刻的位置——别停。',
    en: 'A medium air warship is patrolling to the east, one airburst shell every fifty seconds. It locks the position you were in at that moment. Do not stop moving.' },
  ],
  'story_s02_brief_10': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '空爆弹来的时候散开，弹过去就集合。散开会被各个击破，集合才是活路。',
    en: 'Scatter when the shell is inbound, rally once it is gone. Scattered, you get picked off one by one. Rallied, you live.' },
  ],
  'story_s02_brief_11': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '优先级：运输机载着伤员，先保运输机；轰炸机自己撑一会儿。',
    en: 'Priority: the transports are carrying wounded, so protect them first. The bombers hold on by themselves for now.' },
  ],
  'story_s02_brief_12': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '武器与僚机：导弹打敌机，抵近了机炮补刀。僚机听 1、2、3 号指令——接敌、掩护、归队。',
    en: 'Weapons and wingmen: missiles on fighters, guns to finish up close. Your wingmen answer orders one, two, three: engage, cover, rejoin.' },
  ],
  'story_s02_brief_13': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '这场拦截会很密。弹量和油量都省着用。',
    en: 'This intercept is going to be dense. Watch your ammunition and your fuel.' },
  ],
  'story_s02_brief_14': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '编队入圈之后，立即向西南低空脱离，不要回头。',
    en: 'Once the formation is inside the ring, egress southwest at low altitude. Do not turn back.' },
  ],
  'story_s02_brief_15': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '我知道有人在问，我们为什么会在这里。把问题留到落地以后。',
    en: 'I know some of you are asking why we are here. Save the question until you are on the ground.' },
  ],
  'story_s02_brief_16': [
    { speaker: '穹顶', side: 'awacs', voiceSpeaker: 'awacs',
    text: '简报结束。各机就位。',
    en: 'Briefing complete. All units, man your aircraft.' },
  ],
};
// ============================================================
// === S-01 剧情台词分组 (引擎按游戏事件触发) ===
// ============================================================
// 每组内部严格按顺序播放 —— 用 chatter.triggerSequence(S01_BLOCKS.xxx) 播放,
// 组与组之间的间隔由引擎决定(不要跨组连播)。
export const S01_BLOCKS: Record<
  's0_awacs'
  | 's0_escort'
  | 's1_open'
  | 's1_mount'
  | 's1_loss'
  | 's1_mount2'
  | 's2_trigger'
  | 's2_open'
  | 's2_mount'
  | 's2_loss'
  | 's2_mount2'
  | 's3_trigger'
  | 's3_open'
  | 's3_mount'
  | 's3_anvil'
  | 's3_mount2'
  | 's4_open'
  | 's4_loss'
  | 's4_core'
  | 's4_core2'
  | 's5_fall',  RadioEvent[]
> = {
  // 1 句
  s0_awacs: [
    'story_s01_s0_awacs_01',
  ],
  // 10 句
  s0_escort: [
    'story_s01_s0_escort_01',
    'story_s01_s0_escort_02',
    'story_s01_s0_escort_03',
    'story_s01_s0_escort_04',
    'story_s01_s0_escort_05',
    'story_s01_s0_escort_06',
    'story_s01_s0_escort_07',
    'story_s01_s0_escort_08',
    'story_s01_s0_escort_09',
    'story_s01_s0_escort_10',
  ],
  // 5 句
  s1_open: [
    'story_s01_s2_open_01',
    'story_s01_s2_open_02',
    'story_s01_s2_open_03',
    'story_s01_s2_open_04',
    'story_s01_s2_open_05',
    'story_s01_s2_open_06',
    'story_s01_s2_open_07',
  
  ],
  // 5 句
  s1_mount: [
    'story_s01_s1_mount_01',
    'story_s01_s1_mount_02',
    'story_s01_s1_mount_03',
    'story_s01_s1_mount_04',
    'story_s01_s1_mount_05',
  ],
  // 4 句
  s1_loss: [
    'story_s01_s1_loss_01',
    'story_s01_s1_loss_02',
    'story_s01_s1_loss_03',
    'story_s01_s1_loss_04',
  ],
  // 10 句
  s1_mount2: [
    'story_s01_s1_mount2_01',
    'story_s01_s1_mount2_02',
    'story_s01_s1_mount2_03',
    'story_s01_s1_mount2_04',
    'story_s01_s1_mount2_05',
    'story_s01_s1_mount2_06',
    'story_s01_s1_mount2_07',
    'story_s01_s1_mount2_08',
    'story_s01_s1_mount2_09',
    'story_s01_s1_mount2_10',
  ],
  // 1 句
  s2_trigger: [
    'story_s01_s2_trigger_01',
  ],
  // 7 句
  s2_open: [
    'story_s01_s3_open_01',
    'story_s01_s3_open_02',
    'story_s01_s3_open_03',
    'story_s01_s3_open_04',
    'story_s01_s3_open_05',
    'story_s01_s3_open_06',
    'story_s01_s3_open_07',
    'story_s01_s3_open_08',
    'story_s01_s4_open_01',
    'story_s01_s4_open_02',
  
  ],
  // 7 句
  s2_mount: [
    'story_s01_s2_mount_01',
    'story_s01_s2_mount_02',
    'story_s01_s2_mount_03',
    'story_s01_s2_mount_04',
    'story_s01_s2_mount_05',
    'story_s01_s2_mount_06',
    'story_s01_s2_mount_07',
  ],
  // 4 句
  s2_loss: [
    'story_s01_s2_loss_01',
    'story_s01_s2_loss_02',
    'story_s01_s2_loss_03',
    'story_s01_s2_loss_04',
  ],
  // 8 句
  s2_mount2: [
    'story_s01_s2_mount2_01',
    'story_s01_s2_mount2_02',
    'story_s01_s2_mount2_03',
    'story_s01_s2_mount2_04',
    'story_s01_s2_mount2_05',
    'story_s01_s2_mount2_06',
    'story_s01_s2_mount2_07',
    'story_s01_s2_mount2_08',
  ],
  // 1 句
  s3_trigger: [
    'story_s01_s3_trigger_01',
  ],
  // 8 句
  s3_open: [
    'story_s01_s4_open_03',
    'story_s01_s4_open_04',
    'story_s01_s4_open_05',
    'story_s01_s4_open_06',
    'story_s01_s4_open_07',
    'story_s01_s4_open_08',
  
  ],
  // 8 句
  s3_mount: [
    'story_s01_s3_mount_01',
    'story_s01_s3_mount_02',
    'story_s01_s3_mount_03',
    'story_s01_s3_mount_04',
    'story_s01_s3_mount_05',
    'story_s01_s3_mount_06',
    'story_s01_s3_mount_07',
    'story_s01_s3_mount_08',
  ],
  // 6 句
  s3_anvil: [
    'story_s01_s3_anvil_01',
    'story_s01_s3_anvil_02',
    'story_s01_s3_anvil_03',
    'story_s01_s3_anvil_04',
    'story_s01_s3_anvil_05',
    'story_s01_s3_anvil_06',
  ],
  // 11 句
  s3_mount2: [
    'story_s01_s3_mount2_01',
    'story_s01_s3_mount2_02',
    'story_s01_s3_mount2_03',
    'story_s01_s3_mount2_04',
    'story_s01_s3_mount2_05',
    'story_s01_s3_mount2_06',
    'story_s01_s3_mount2_07',
    'story_s01_s3_mount2_08',
    'story_s01_s3_mount2_09',
    'story_s01_s3_mount2_10',
    'story_s01_s3_mount2_11',
  ],
  // 8 句
  s4_open: [
  
  ],
  // 4 句
  s4_loss: [
    'story_s01_s4_loss_01',
    'story_s01_s4_loss_02',
    'story_s01_s4_loss_03',
    'story_s01_s4_loss_04',
  ],
  // 10 句
  s4_core: [
    'story_s01_s4_core_01',
    'story_s01_s4_core_02',
    'story_s01_s4_core_03',
    'story_s01_s4_core_04',
    'story_s01_s4_core_05',
    'story_s01_s4_core_06',
    'story_s01_s4_core_07',
    'story_s01_s4_core_08',
    'story_s01_s4_core_09',
    'story_s01_s4_core_10',
  ],
  // 4 句
  s4_core2: [
    'story_s01_s4_core2_01',
    'story_s01_s4_core2_02',
    'story_s01_s4_core2_03',
    'story_s01_s4_core2_04',
  ],
  // 7 句
  s5_fall: [
    'story_s01_s5_fall_01',
    'story_s01_s5_fall_02',
    'story_s01_s5_fall_03',
    'story_s01_s5_fall_04',
    'story_s01_s5_fall_05',
    'story_s01_s5_fall_06',
    'story_s01_s5_fall_07',
  ],
};
// ============================================================
// === S-01 我方/盟友剧情台词分组 (与 S01_BLOCKS 同构, 引擎按游戏事件触发) ===
// ============================================================
// 每组内部严格按顺序播放 —— 用 chatter.triggerSequence(S01_ALLY_BLOCKS.xxx) 播放。
// 与 S01_BLOCKS 的区别: 这里全是 side:'ally' 的己方通讯, 引擎可以按需要
// 交叉调用两组(例如阶段开场先播我方, 再播敌方), 组间间隔由引擎决定。
/** 关卡内过场运镜台词槽(占位符): 开场 6 句 + 坠落 4 句。 */
export const S01_CINEMATIC: Record<'intro' | 'crash', RadioEvent[]> = {
  intro: [
    'story_s01_cine_intro_01', 'story_s01_cine_intro_02', 'story_s01_cine_intro_03',
    'story_s01_cine_intro_04', 'story_s01_cine_intro_05', 'story_s01_cine_intro_06',
  ],
  crash: [
    'story_s01_cine_crash_01', 'story_s01_cine_crash_02',
    'story_s01_cine_crash_03', 'story_s01_cine_crash_04',
  ],
};
export const S01_ALLY_BLOCKS: Record<
  's0_open'
  | 's1_open'
  | 's1_first'
  | 's1_half'
  | 's1_last'
  | 's2_open'
  | 's2_half'
  | 's2_last'
  | 's3_open'
  | 's3_charge'
  | 's3_laser1'
  | 's3_anvil1'
  | 's3_anvil2'
  | 's3_lasers_clear'
  | 's4_open'
  | 's4_core1'
  | 's4_core2'
  | 's4_core3'
  | 's4_core4'
  | 's5_fall',  RadioEvent[]
> = {
  // 11 句
  s0_open: [
    'story_s01_s1_open_01',
    'story_s01_s1_open_02',
    'story_s01_s1_open_03',
    'story_s01_s1_open_04',
    'story_s01_s1_open_05',
  
  ],
  // 10 句
  s1_open: [
    'story_s01_ally_s1_open_01',
    'story_s01_ally_s1_open_02',
    'story_s01_ally_s1_open_03',
    'story_s01_ally_s1_open_04',
    'story_s01_ally_s1_open_05',
    'story_s01_ally_s1_open_06',
    'story_s01_ally_s1_open_07',
    'story_s01_ally_s1_open_08',
    'story_s01_ally_s1_open_09',
    'story_s01_ally_s1_open_10',
  ],
  // 5 句
  s1_first: [
    'story_s01_ally_s1_first_01',
    'story_s01_ally_s1_first_02',
    'story_s01_ally_s1_first_03',
    'story_s01_ally_s1_first_04',
    'story_s01_ally_s1_first_05',
  ],
  // 6 句
  s1_half: [
    'story_s01_ally_s1_half_01',
    'story_s01_ally_s1_half_02',
    'story_s01_ally_s1_half_03',
    'story_s01_ally_s1_half_04',
    'story_s01_ally_s1_half_05',
    'story_s01_ally_s1_half_06',
  ],
  // 5 句
  s1_last: [
    'story_s01_ally_s1_last_01',
    'story_s01_ally_s1_last_02',
    'story_s01_ally_s1_last_03',
    'story_s01_ally_s1_last_04',
    'story_s01_ally_s1_last_05',
  ],
  // 9 句
  s2_open: [
    'story_s01_ally_s2_open_01',
    'story_s01_ally_s2_open_02',
    'story_s01_ally_s2_open_03',
    'story_s01_ally_s2_open_04',
    'story_s01_ally_s2_open_05',
    'story_s01_ally_s2_open_06',
    'story_s01_ally_s2_open_07',
    'story_s01_ally_s2_open_08',
    'story_s01_ally_s2_open_09',
  ],
  // 6 句
  s2_half: [
    'story_s01_ally_s2_half_01',
    'story_s01_ally_s2_half_02',
    'story_s01_ally_s2_half_03',
    'story_s01_ally_s2_half_04',
    'story_s01_ally_s2_half_05',
    'story_s01_ally_s2_half_06',
  ],
  // 5 句
  s2_last: [
    'story_s01_ally_s2_last_01',
    'story_s01_ally_s2_last_02',
    'story_s01_ally_s2_last_03',
    'story_s01_ally_s2_last_04',
    'story_s01_ally_s2_last_05',
  ],
  // 10 句
  s3_open: [
    'story_s01_ally_s3_open_01',
    'story_s01_ally_s3_open_02',
    'story_s01_ally_s3_open_03',
    'story_s01_ally_s3_open_04',
    'story_s01_ally_s3_open_05',
    'story_s01_ally_s3_open_06',
    'story_s01_ally_s3_open_07',
    'story_s01_ally_s3_open_08',
    'story_s01_ally_s3_open_09',
    'story_s01_ally_s3_open_10',
  ],
  // 4 句
  s3_charge: [
    'story_s01_ally_s3_charge_01',
    'story_s01_ally_s3_charge_02',
    'story_s01_ally_s3_charge_03',
    'story_s01_ally_s3_charge_04',
  ],
  // 3 句
  s3_laser1: [
    'story_s01_ally_s3_laser1_01',
    'story_s01_ally_s3_laser1_02',
    'story_s01_ally_s3_laser1_03',
  ],
  // 4 句
  s3_anvil1: [
    'story_s01_ally_s3_anvil1_01',
    'story_s01_ally_s3_anvil1_02',
    'story_s01_ally_s3_anvil1_03',
    'story_s01_ally_s3_anvil1_04',
  ],
  // 3 句
  s3_anvil2: [
    'story_s01_ally_s3_anvil2_01',
    'story_s01_ally_s3_anvil2_02',
    'story_s01_ally_s3_anvil2_03',
  ],
  // 5 句
  s3_lasers_clear: [
    'story_s01_ally_s3_lasers_clear_01',
    'story_s01_ally_s3_lasers_clear_02',
    'story_s01_ally_s3_lasers_clear_03',
    'story_s01_ally_s3_lasers_clear_04',
    'story_s01_ally_s3_lasers_clear_05',
  ],
  // 9 句
  s4_open: [
    'story_s01_ally_s4_open_01',
    'story_s01_ally_s4_open_02',
    'story_s01_ally_s4_open_03',
    'story_s01_ally_s4_open_04',
    'story_s01_ally_s4_open_05',
    'story_s01_ally_s4_open_06',
    'story_s01_ally_s4_open_07',
    'story_s01_ally_s4_open_08',
    'story_s01_ally_s4_open_09',
  ],
  // 4 句
  s4_core1: [
    'story_s01_ally_s4_core1_01',
    'story_s01_ally_s4_core1_02',
    'story_s01_ally_s4_core1_03',
    'story_s01_ally_s4_core1_04',
  ],
  // 3 句
  s4_core2: [
    'story_s01_ally_s4_core2_01',
    'story_s01_ally_s4_core2_02',
    'story_s01_ally_s4_core2_03',
  ],
  // 3 句
  s4_core3: [
    'story_s01_ally_s4_core3_01',
    'story_s01_ally_s4_core3_02',
    'story_s01_ally_s4_core3_03',
  ],
  // 8 句
  s4_core4: [
    'story_s01_ally_s4_core4_01',
    'story_s01_ally_s4_core4_02',
    'story_s01_ally_s4_core4_03',
    'story_s01_ally_s4_core4_04',
    'story_s01_ally_s4_core4_05',
    'story_s01_ally_s4_core4_06',
    'story_s01_ally_s4_core4_07',
    'story_s01_ally_s4_core4_08',
  ],
  // 6 句
  s5_fall: [
    'story_s01_ally_s5_fall_01',
    'story_s01_ally_s5_fall_02',
    'story_s01_ally_s5_fall_03',
    'story_s01_ally_s5_fall_04',
    'story_s01_ally_s5_fall_05',
    'story_s01_ally_s5_fall_06',
  ],
};
// ============================================================
// === S-02 剧情台词分组 (由 engine.ts 的 updateStoryS02 按阶段驱动) ===
// ============================================================
// 每组内部严格按顺序播放 —— 用 chatter.triggerSequence(S02_BLOCKS.xxx) 播放,
// 组与组之间的间隔由引擎决定(不要跨组连播)。数组顺序 = 剧本行序, 不可重排。
// 语音本轮为占位符: 不产出 mp3(路径 /audio/radio/<id>-0.mp3 不存在),
// 运行时自动降级为「只显示字幕」(见 presentSubtitleOnly), 不影响游戏流程。
export const S02_BLOCKS: Record<
  | 's0_open'
  | 's1_open'
  | 's2_open'
  | 's3_open'
  | 's4_open'
  | 's5_open'
  | 's6_open'
  | 's7_base'
  | 's8_hangar'
  | 's11_warn'
  | 's10_ship'
  | 's9_ace',
  RadioEvent[]
> = {
  s0_open: [
    'story_s02_s0_open_01',
    'story_s02_s0_open_02',
    'story_s02_s0_open_03',
    'story_s02_s0_open_04',
    'story_s02_s0_open_05',
    'story_s02_s0_open_06',
    'story_s02_s0_open_07',
    'story_s02_s0_open_08',
    'story_s02_s0_open_09',
    'story_s02_s0_open_10',
    'story_s02_s0_open_11',
    'story_s02_s0_open_12',
    'story_s02_s0_open_13',
    'story_s02_s0_open_14',
    'story_s02_s0_open_15',
    'story_s02_s0_open_16',
    'story_s02_s0_open_17',
    'story_s02_s0_open_18',
  ],
  s1_open: [
    'story_s02_s1_open_01',
    'story_s02_s1_open_02',
    'story_s02_s1_open_03',
    'story_s02_s1_open_04',
    'story_s02_s1_open_05',
    'story_s02_s1_open_06',
    'story_s02_s1_open_07',
    'story_s02_s1_open_08',
    'story_s02_s1_open_09',
    'story_s02_s1_open_10',
    'story_s02_s1_open_11',
    'story_s02_s1_open_12',
    'story_s02_s1_open_13',
    'story_s02_s1_open_14',
    'story_s02_s1_open_15',
    'story_s02_s1_open_16',
  ],
  s2_open: [
    'story_s02_s2_open_01',
    'story_s02_s2_open_02',
    'story_s02_s2_open_03',
    'story_s02_s2_open_04',
    'story_s02_s2_open_05',
    'story_s02_s2_open_06',
    'story_s02_s2_open_07',
    'story_s02_s2_open_08',
    'story_s02_s2_open_09',
    'story_s02_s2_open_10',
    'story_s02_s2_open_11',
    'story_s02_s2_open_12',
    'story_s02_s2_open_13',
    'story_s02_s2_open_14',
    'story_s02_s2_open_15',
    'story_s02_s2_open_16',
    'story_s02_s2_open_17',
    'story_s02_s2_open_18',
    'story_s02_s2_open_19',
    'story_s02_s2_open_20',
    'story_s02_s2_open_21',
    'story_s02_s2_open_22',
    'story_s02_s2_open_23',
    'story_s02_s2_open_24',
    'story_s02_s2_open_25',
    'story_s02_s2_open_26',
    'story_s02_s2_open_27',
    'story_s02_s2_open_28',
    'story_s02_s2_open_29',
    'story_s02_s2_open_30',
    'story_s02_s2_open_31',
    'story_s02_s2_open_32',
  ],
  s3_open: [
    'story_s02_s3_open_01',
    'story_s02_s3_open_02',
    'story_s02_s3_open_03',
    'story_s02_s3_open_04',
    'story_s02_s3_open_05',
    'story_s02_s3_open_06',
    'story_s02_s3_open_07',
    'story_s02_s3_open_08',
    'story_s02_s3_open_09',
    'story_s02_s3_open_10',
    'story_s02_s3_open_11',
    'story_s02_s3_open_12',
    'story_s02_s3_open_13',
    'story_s02_s3_open_14',
    'story_s02_s3_open_15',
    'story_s02_s3_open_16',
    'story_s02_s3_open_17',
    'story_s02_s3_open_18',
    'story_s02_s3_open_19',
    'story_s02_s3_open_20',
    'story_s02_s3_open_21',
    'story_s02_s3_open_22',
    'story_s02_s3_open_23',
    'story_s02_s3_open_24',
    'story_s02_s3_open_25',
    'story_s02_s3_open_26',
    'story_s02_s3_open_27',
    'story_s02_s3_open_28',
    'story_s02_s3_open_29',
    'story_s02_s3_open_30',
    'story_s02_s3_open_31',
  ],
  s4_open: [
    'story_s02_s4_open_01',
    'story_s02_s4_open_02',
    'story_s02_s4_open_03',
    'story_s02_s4_open_04',
    'story_s02_s4_open_05',
    'story_s02_s4_open_06',
    'story_s02_s4_open_07',
    'story_s02_s4_open_08',
    'story_s02_s4_open_09',
    'story_s02_s4_open_10',
    'story_s02_s4_open_11',
    'story_s02_s4_open_12',
    'story_s02_s4_open_13',
    'story_s02_s4_open_14',
    'story_s02_s4_open_15',
    'story_s02_s4_open_16',
    'story_s02_s4_open_17',
    'story_s02_s4_open_18',
    'story_s02_s4_open_19',
    'story_s02_s4_open_20',
    'story_s02_s4_open_21',
    'story_s02_s4_open_22',
    'story_s02_s4_open_23',
    'story_s02_s4_open_24',
    'story_s02_s4_open_25',
    'story_s02_s4_open_26',
    'story_s02_s4_open_27',
    'story_s02_s4_open_28',
    'story_s02_s4_open_29',
    'story_s02_s4_open_30',
    'story_s02_s4_open_31',
    'story_s02_s4_open_32',
    'story_s02_s4_open_33',
    'story_s02_s4_open_34',
    'story_s02_s4_open_35',
    'story_s02_s4_open_36',
  ],
  s5_open: [
    'story_s02_s5_open_17',
    'story_s02_s5_open_18',
    'story_s02_s5_open_19',
    'story_s02_s5_open_20',
    'story_s02_s5_open_21',
    'story_s02_s5_open_22',
    'story_s02_s5_open_23',
    'story_s02_s5_open_24',
    'story_s02_s5_open_25',
    'story_s02_s5_open_26',
  
  ],
  s6_open: [
    'story_s02_s5_open_27',
    'story_s02_s5_open_28',
    'story_s02_s5_open_29',
    'story_s02_s5_open_30',
    'story_s02_s5_open_31',
    'story_s02_s5_open_32',
    'story_s02_s5_open_33',
  
  ],
  s7_base: [
    'story_s02_s5_open_34',
    'story_s02_s5_open_35',
    'story_s02_s5_open_36',
    'story_s02_s5_open_37',
    'story_s02_s5_open_38',
    'story_s02_s5_open_39',
    'story_s02_s5_open_40',
  
  ],
  s8_hangar: [
  
  ],
  s9_ace: [
    'story_s02_s5_open_41',
    'story_s02_s5_open_42',
    'story_s02_s5_open_43',
    'story_s02_s5_open_44',
    'story_s02_s5_open_45',
    'story_s02_s5_open_46',
    'story_s02_s5_open_47',
    'story_s02_s5_open_48',
    'story_s02_s5_open_49',
    'story_s02_s5_open_50',
    'story_s02_s5_open_51',
    'story_s02_s5_open_52',
    'story_s02_s5_open_53',
    'story_s02_s5_open_54',
  ],
  s10_ship: [
    'story_s02_s5_open_55',
    'story_s02_s5_open_56',
    'story_s02_s5_open_57',
    'story_s02_s5_open_58',
    'story_s02_s5_open_59',
    'story_s02_s5_open_60',
  ],
  s11_warn: [
    'story_s02_s5_open_61',
    'story_s02_s5_open_62',
    'story_s02_s5_open_63',
    'story_s02_s5_open_64',
    'story_s02_s5_open_65',
  ],
};
/** 堡垒管制的随机常规台词(池内 4 个变体, 可多次触发)。 */
/** 简报/结算界面用的取词接口 (per user request: 简报和结算都有台词)
 *  返回该事件第一句的说话人/中文/英文 + 占位语音路径。
 *  语音本轮不生成: 路径不存在时界面只显示字幕(与关卡内 presentSubtitleOnly 同一策略)。 */
export function storyLineInfo(ev: RadioEvent): { speaker: string; zh: string; en: string; voiceFile: string } {
  const line = (LINES[ev] ?? [])[0];
  return {
    speaker: line ? line.speaker : '',
    zh: line ? line.text : '',
    en: line && line.en ? line.en : (line ? line.text : ''),
    voiceFile: RADIO_VOICE_DIR + '/' + ev + '-0.mp3',
  };
}
/** 正式版剧情第一关: 简报台词(菜单 3D 简报界面按顺序显示)
 *  顺序 = 作战简报的叙事逻辑(共 18 句):
 *    开场 01 → 为什么打 07-09(形势/威胁/命令与约束)
 *    → 我们有什么 10-11(力量/时限与弹药) → 目标诸元 02 → 阶段换装 03
 *    → 交战顺序与威胁 12-14(护航队顺序/激光/蜂群) → 挂点规则 04 → 核心规则 05
 *    → 武器与分工 15-16(武器/僚机指令) → 空域警告 06 → 收尾 17-18(坠落/撤离) */
export const S01_BRIEF: RadioEvent[] = [
  'story_s01_brief_01',
  'story_s01_brief_07',  // 形势: 敌方新造战略级空中战舰
  'story_s01_brief_08',  // 威胁: 抵达发射阵位后的火力覆盖
  'story_s01_brief_09',  // 命令与约束: 公海击落 / 残骸不落港
  'story_s01_brief_10',  // 我方力量
  'story_s01_brief_11',  // 时限与弹药约束
  'story_s01_brief_02',  // 目标诸元
  'story_s01_brief_03',  // 阶段换装
  'story_s01_brief_12',  // 交战顺序: 三支护航队
  'story_s01_brief_13',  // 激光阵列
  'story_s01_brief_14',  // 蜂群无人机
  'story_s01_brief_04',  // 挂点全毁才进阶段
  'story_s01_brief_05',  // 四个核心
  'story_s01_brief_15',  // 武器分配
  'story_s01_brief_16',  // 僚机指令
  'story_s01_brief_06',  // 空域警告
  'story_s01_brief_17',  // 核心坠落条件
  'story_s01_brief_18',  // 撤离与禁停区
];
/** 正式版剧情第一关: 结算台词(菜单 3D 结算界面按顺序显示) */
export const S01_DEBRIEF: RadioEvent[] = [
  'story_s01_debrief_01', 'story_s01_debrief_02',
  'story_s01_debrief_03', 'story_s01_debrief_04',
];
export const S01_RANDOM_CONTROL: RadioEvent = 'story_s01_rand_control';
/** 正式版剧情第二关《洞川撤退》: 简报台词(菜单 3D 简报界面按顺序显示)
 *  StoryBrief 按 `<关卡ID大写>_BRIEF` 自动取用(s02 → S02_BRIEF), 所以这里一导出,
 *  第二关的简报就从"任务书自动切句(无配音)"升级为"脚本台词 + 配音"。
 *  顺序 = 作战简报的叙事逻辑(共 16 句):
 *    开场 01 → 军事目的 02 → 护航对象 03 → 编队损伤 04 → 敌情三波 05 → 怎么打 06
 *    → 时限 07 → 王牌「隼」08 → 空爆战舰 09 → 空爆应对 10 → 优先级 11
 *    → 武器与僚机 12 → 油弹 13 → 撤离 14 → 情绪点 15 → 结束 16 */
export const S02_BRIEF: RadioEvent[] = [
  'story_s02_brief_01',
  'story_s02_brief_02',
  'story_s02_brief_03',
  'story_s02_brief_04',
  'story_s02_brief_05',
  'story_s02_brief_06',
  'story_s02_brief_07',
  'story_s02_brief_08',
  'story_s02_brief_09',
  'story_s02_brief_10',
  'story_s02_brief_11',
  'story_s02_brief_12',
  'story_s02_brief_13',
  'story_s02_brief_14',
  'story_s02_brief_15',
  'story_s02_brief_16',
];
// ============================================================
// === OFFLINE CATALOG EXPORT (used by scripts/export-radio-voices.ts) ===
// ============================================================
// === 主角无线电语音总开关 (per user request: 先放着不播放) ===
// true = 只出字幕 + 电台静噪, 不播语音素材(音效文件仍在仓库里, 未删除)。
// 想恢复语音:把这里改成 false。
const RADIO_VOICE_MUTED = true;
export interface RadioVoicePlanEntry {
  /** Stable audio id: `<event>-<pool index>` — pool index doubles as the file suffix. */
  id: string;
  event: RadioEvent;
  idx: number;
  speaker: string;
  side: RadioSide;
  role: Speaker;
  /** Chinese subtitle (HUD text). */
  text: string;
  /** TTS-friendly speech text (lightly normalized copy of `text`). */
  speech: string;
  /** English script line (`LinePool.en`) — the English voice take's source text. */
  en: string;
  /** TTS-friendly English speech (normalized `en`, falls back to `text`). */
  enSpeech: string;
  category: RadioCategory;
}
/** Make a Chinese subtitle comfortable for a TTS engine to read aloud. */
export function normalizeRadioSpeech(text: string): string {
  let s = text;
  // Ellipsis / long dashes → terminal punctuation (TTS reads them as pauses).
  s = s.replace(/……+/g, '。').replace(/\.\.\.+/g, '。').replace(/——+/g, '，').replace(/—+/g, '，');
  // Keep it tight — remove soft spaces meant for layout.
  s = s.replace(/[ \u3000]+/g, '');
  if (!/[。！？；]$/.test(s)) s += '。';
  return s;
}
/** Normalize an English line for TTS: ellipses/dashes → clean punctuation. */
export function normalizeRadioSpeechEn(text: string): string {
  let s = text;
  s = s.replace(/[.…]{2,}/g, '.').replace(/\.\.\.+/g, '.');
  s = s.replace(/[—–]{1,}/g, ',');
  s = s.replace(/\s+/g, ' ').trim();
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}
const RADIO_EVENTS = Object.keys(LINES) as RadioEvent[];
/** Full per-line catalog with stable ids for offline TTS batch generation. */
export function getRadioVoicePlan(): RadioVoicePlanEntry[] {
  const out: RadioVoicePlanEntry[] = [];
  for (const event of RADIO_EVENTS) {
    const pool = LINES[event];
    pool.forEach((line, idx) => {
      const en = line.en ?? line.voice ?? '';
      out.push({
        id: `${event}-${idx}`,
        event,
        idx,
        speaker: line.speaker,
        side: line.side,
        role: line.voiceSpeaker,
        text: line.text,
        speech: normalizeRadioSpeech(line.text),
        en,
        enSpeech: normalizeRadioSpeechEn(en || line.text),
        category: eventCategory(event),
      });
    });
  }
  return out;
}
// ============================================================
// === RadioChatter — single-flight serialized voice queue ===
// ============================================================
export class RadioChatter {
  private queue: RadioMessage[] = [];
  private nextId = 1;
  private lastEventTime: Partial<Record<RadioEvent, number>> = {};
  private lastLineIndex: Partial<Record<RadioEvent, number>> = {};
  private audio: AudioEngine;
  // Cooldown to prevent spamming the same event type
  private cooldownMs = 1800;
  // === Single-flight state (per user request: 整句念完才能开始下一句) ===
  private active: RadioMessage | null = null;
  private channelFreeAt = 0;   // wall seconds — earliest the next line may open
  private speakToken = 0;      // invalidated on clear()/watchdog so late audio can't start
  private readonly MAX_PENDING = 8;
  private readonly INTERLINE_GAP = 0.45; // breathing room between transmissions
  // === Story-sequence queue headroom ===
  // triggerSequence() enqueues a whole block at once; the normal 8-slot cap
  // would silently drop the tail of the sequence (dropLowestPending), so while
  // a sequence is pending the cap is temporarily raised to 24 — enough for the
  // longest scripted block (11 lines) plus a few alerts. The raised cap stays
  // in effect until `sequencePendingUntil` (end of the sequence + 6 s tail).
  private readonly MAX_PENDING_SEQUENCE = 24;
  private sequencePendingUntil = 0;
  constructor(audio: AudioEngine) {
    this.audio = audio;
  }
  /**
   * Trigger a radio event. The system picks a line (anti-repeat), computes its
   * voice file name and enqueues it. Playback is single-flight — see update().
   * Replays of the same event within `cooldownMs` are dropped.
   */
  trigger(event: RadioEvent, opts: { force?: boolean; delay?: number; cooldownMs?: number } = {}) {
    const now = performance.now();
    const cd = opts.cooldownMs ?? this.cooldownMs;
    if (!opts.force) {
      const last = this.lastEventTime[event] ?? 0;
      if (now - last < cd) return;
    }
    this.lastEventTime[event] = now;
    const pool = LINES[event];
    if (!pool || pool.length === 0) return;
    // Anti-repetition: avoid picking the same line as last time
    let idx = Math.floor(Math.random() * pool.length);
    const lastIdx = this.lastLineIndex[event];
    if (pool.length > 1 && idx === lastIdx) {
      idx = (idx + 1) % pool.length;
    }
    this.lastLineIndex[event] = idx;
    const line = pool[idx];
    const category = eventCategory(event);
    const isStory = category === 'story';
    const voiceFile = `${RADIO_VOICE_DIR}/${event}-${idx}.mp3`;
    // === Story lines must not wait behind a wall of routine chatter ===
    // They still never interrupt an in-flight line, but when the channel frees
    // up they outrank alerts and normal chatter (see pickNextDue).
    const startAt = now / 1000 + (opts.delay ?? (isStory ? 0.1 : 0.15));
    const text = lineText(line); // locale-aware subtitle (en / zh)
    const msg: RadioMessage = {
      id: this.nextId++,
      speaker: line.speaker,
      side: line.side,
      text,
      category,
      voiceFile,
      duration: estimateDuration(text),
      startAt,
      voiceSpeaker: line.voiceSpeaker,
      started: false,
      endAt: 0,
    };
    // Kick off a background decode now so the file is warm when it plays.
    if (this.audio.isReady()) {
      this.audio.preloadRadioVoice(voiceFile).catch(() => { /* missing file → subtitle-only later */ });
    }
    const cap = now / 1000 < this.sequencePendingUntil ? this.MAX_PENDING_SEQUENCE : this.MAX_PENDING;
    if (this.queue.length >= cap) this.dropLowestPending();
    this.queue.push(msg);
  }
  /**
   * 按顺序播放一串台词(剧情对话用) —— 内部按 gap 秒间隔排队, 不抢占正在播的台词。
   *
   * - 复用同一个队列 / 单飞播放逻辑, 不另建队列: 每句都走 trigger(), 只是带上
   *   `(i + 1) * gap` 的 delay, 所以正在播的那句照旧念完才轮到下一句。
   * - 顺序由 delay 保证(story 优先级相同, pickNextDue 按 startAt 升序取)。
   * - 序列排队期间队列上限抬到 MAX_PENDING_SEQUENCE(24), 避免长序列被丢尾巴。
   * - 传 S01_BLOCKS.xxx 即可播放第一关的整组剧情台词。
   *
   * @param gap 句与句的间隔(秒), 默认 3.6 —— 留出念完一句 + 静噪的时间。
   */
  triggerSequence(events: RadioEvent[], opts: { gap?: number; force?: boolean } = {}) {
    if (events.length === 0) return;
    const gap = opts.gap ?? 3.6;
    const baseDelay = 0.1; // same pre-roll story lines normally get
    const now = performance.now() / 1000;
    // Keep the raised queue cap for the whole sequence + a small tail window.
    this.sequencePendingUntil = now + events.length * gap + 6;
    for (let i = 0; i < events.length; i++) {
      this.trigger(events[i], {
        force: opts.force ?? true,   // scripted lines ignore the anti-spam cooldown
        delay: (i + 1) * gap + baseDelay,
      });
    }
  }
  /**
   * Advance the single-flight queue. Call every frame (engine emitHud).
   * Returns the messages currently visible as HUD subtitles (at most the one
   * line actually being spoken right now).
   */
  update(): RadioMessage[] {
    const now = performance.now() / 1000;
    // 1) Watchdogs — a voice that never started (decode stall) or whose end
    //    event was lost (hidden tab / suspended context) must not block the
    //    channel forever.
    if (this.active) {
      if (!this.active.started) {
        // Stuck in the pre-roll decode for too long → fall back to subtitle-only.
        if (now - this.active.startAt > 4) this.abortActiveToSubtitleOnly(now);
      } else if (this.active.endAt === 0 && now > this.active.startAt + this.active.duration + 3) {
        // Real playback was supposed to be over — force-close it.
        this.active.endAt = now;
        this.audio.stopRadioVoice();
      }
    }
    // 2) Finalize the active line once its subtitle window has elapsed.
    if (this.active && this.active.started && this.active.endAt > 0 && now >= this.active.endAt) {
      this.active = null;
      this.channelFreeAt = now + this.INTERLINE_GAP;
    }
    // 3) When the channel is free, pick the next due line by priority.
    if (!this.active && now >= this.channelFreeAt) {
      const next = this.pickNextDue(now);
      if (next) {
        this.queue = this.queue.filter((m) => m !== next);
        this.beginSpeak(next);
      }
    }
    // Visible = the one line currently being spoken (kept on screen through
    // its end-of-speech tail so the subtitle doesn't flicker out early).
    if (this.active && this.active.started && (this.active.endAt === 0 || now < this.active.endAt)) {
      return [this.active];
    }
    return [];
  }
  /** Pick the highest-priority due message (story > alert > normal, then earliest). */
  private pickNextDue(now: number): RadioMessage | null {
    let best: RadioMessage | null = null;
    for (const m of this.queue) {
      if (m.startAt > now) continue; // not due yet
      if (!best) { best = m; continue; }
      const a = priorityRank(m.category);
      const b = priorityRank(best.category);
      if (a !== b) { if (a > b) best = m; continue; }
      if (m.startAt !== best.startAt) { if (m.startAt < best.startAt) best = m; continue; }
      if (m.id < best.id) best = m;
    }
    return best;
  }
  /** Drop the lowest-priority pending message to make room (keeps alerts/story). */
  private dropLowestPending() {
    let dropAt = -1;
    let dropRank = Infinity;
    let dropStart = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const m = this.queue[i];
      const r = priorityRank(m.category);
      if (r < dropRank || (r === dropRank && m.startAt < dropStart)) {
        dropRank = r;
        dropStart = m.startAt;
        dropAt = i;
      }
    }
    if (dropAt >= 0) this.queue.splice(dropAt, 1);
  }
  /** Begin speaking a message (opening squelch → voice → subtitle). */
  private beginSpeak(msg: RadioMessage) {
    const token = ++this.speakToken;
    this.active = msg;
    msg.startAt = performance.now() / 1000;
    // === 玩家无线电语音暂时关闭 (per user request: 只禁用玩家自己的语音) ===
    // 范围: **只有玩家**的台词走 subtitle-only; 队友/预警机/敌机的语音照常播。
    // 判据 voiceSpeaker === 'player'(通话记录里"白隼1号 / 玩家"那些行都是它)。
    // 做成开关而不是删代码: 想恢复就把常量改成 false(或接进设置项)。
    if (RADIO_VOICE_MUTED && msg.voiceSpeaker === 'player') {
      this.presentSubtitleOnly(msg, token);
      return;
    }
    // Audio graph not up yet (pre-first-gesture) → subtitle-only immediately.
    if (!this.audio.isReady()) {
      this.presentSubtitleOnly(msg, token);
      return;
    }
    // === 不再播程序化"电台音色"(Squelch) (per user: AI 击毁播报不要再有遗留的程序化音色) ===
    // 以前每次通报前后各放一声"咔哒"让听感像电台; 现在通报都有真实语音(或占位语音),
    // 那两声就是遗留物 —— 整条链路不再播(audio.radioSquelch 本身保留, 将来做设置项或别处要用)。
    // Static bed + subtitle once the real voice length is known. Voice itself
    // starts synchronously inside playRadioVoice after its (cached) decode.
    this.audio.playRadioVoice(msg.voiceFile, {
      volume: 1.0,
      onEnded: () => {
        if (this.active !== msg || token !== this.speakToken) return;
        // (结尾那声程序化音色同样去掉 —— 见 beginSpeak 处的说明)
        // Subtitle lingers through the static fade-out.
        msg.endAt = performance.now() / 1000 + 0.35;
      },
    })
      .then((buf) => {
        if (this.active !== msg || token !== this.speakToken) {
          this.audio.stopRadioVoice(); // a watchdog/clear raced us — cut late audio
          return;
        }
        if (!buf) { this.presentSubtitleOnly(msg, token); return; }
        const t = performance.now() / 1000;
        msg.startAt = t;
        msg.started = true;
        msg.duration = buf.duration + 0.35; // subtitle lingers past the words
        // Static bed exactly matches the voice length + fade-out tail.
        try { this.audio.radioStatic(buf.duration + 0.35, 0.6); } catch { /* ignore */ }
      })
      .catch(() => this.presentSubtitleOnly(msg, token));
  }
  /** Watchdog: a line that never began (decode stalled) becomes subtitle-only. */
  private abortActiveToSubtitleOnly(now: number) {
    const msg = this.active;
    if (!msg) return;
    this.speakToken++;            // invalidate any in-flight promise
    this.audio.stopRadioVoice();
    msg.startAt = now;
    msg.started = true;
    msg.duration = estimateDuration(msg.text);
    msg.endAt = now + msg.duration;
  }
  /** Show the subtitle for an estimated window when no voice is playable. */
  private presentSubtitleOnly(msg: RadioMessage, token: number) {
    if (this.active !== msg || token !== this.speakToken) return;
    const t = performance.now() / 1000;
    msg.startAt = t;
    msg.started = true;
    msg.duration = estimateDuration(msg.text);
    msg.endAt = t + msg.duration;
  }
  /** Clear all queued messages and stop any in-flight voice immediately. */
  clear() {
    this.queue = [];
    this.active = null;
    this.channelFreeAt = 0;
    this.speakToken++;
    this.audio.stopRadioVoice();
  }
}