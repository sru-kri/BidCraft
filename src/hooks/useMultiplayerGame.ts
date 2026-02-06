import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { MarketEvent, getRandomEvent } from '@/lib/gameEvents';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface Player {
  id: string;
  name: string;
  capital: number;
  round: number;
  is_eliminated: boolean;
  last_action: string | null;
}

export interface GameRoom {
  id: string;
  code: string;
  status: 'waiting' | 'playing' | 'finished';
  current_round: number;
  current_event: string | null;
  host_id: string | null;
}

export function useMultiplayerGame() {
  const [room, setRoom] = useState<GameRoom | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [currentEvent, setCurrentEvent] = useState<MarketEvent | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [channel, setChannel] = useState<RealtimeChannel | null>(null);

  // Subscribe to room changes
  useEffect(() => {
    if (!room?.id) return;

    const roomChannel = supabase
      .channel(`room:${room.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_rooms',
          filter: `id=eq.${room.id}`,
        },
        (payload) => {
          console.log('Room update:', payload);
          if (payload.eventType === 'UPDATE') {
            const updatedRoom = payload.new as GameRoom;
            setRoom(updatedRoom);
            if (updatedRoom.current_event) {
              try {
                setCurrentEvent(JSON.parse(updatedRoom.current_event));
              } catch {
                console.error('Failed to parse event');
              }
            }
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'players',
          filter: `room_id=eq.${room.id}`,
        },
        (payload) => {
          console.log('Player update:', payload);
          if (payload.eventType === 'INSERT') {
            setPlayers(prev => [...prev, payload.new as Player]);
          } else if (payload.eventType === 'UPDATE') {
            setPlayers(prev =>
              prev.map(p => (p.id === payload.new.id ? (payload.new as Player) : p))
            );
          } else if (payload.eventType === 'DELETE') {
            setPlayers(prev => prev.filter(p => p.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    setChannel(roomChannel);

    return () => {
      roomChannel.unsubscribe();
    };
  }, [room?.id]);

  const createRoom = useCallback(async (playerName: string) => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Create player first
    const { data: player, error: playerError } = await supabase
      .from('players')
      .insert({ name: playerName })
      .select()
      .single();

    if (playerError || !player) {
      console.error('Failed to create player:', playerError);
      return null;
    }

    // Create room with player as host
    const { data: newRoom, error: roomError } = await supabase
      .from('game_rooms')
      .insert({
        code,
        host_id: player.id,
        status: 'waiting',
      })
      .select()
      .single();

    if (roomError || !newRoom) {
      console.error('Failed to create room:', roomError);
      return null;
    }

    // Update player with room_id
    await supabase
      .from('players')
      .update({ room_id: newRoom.id })
      .eq('id', player.id);

    setPlayerId(player.id);
    setRoom(newRoom as GameRoom);
    setPlayers([player as Player]);
    setIsHost(true);

    return newRoom.code;
  }, []);

  const joinRoom = useCallback(async (code: string, playerName: string) => {
    // Find room by code
    const { data: existingRoom, error: roomError } = await supabase
      .from('game_rooms')
      .select()
      .eq('code', code.toUpperCase())
      .maybeSingle();

    if (roomError || !existingRoom) {
      console.error('Room not found:', roomError);
      return false;
    }

    if (existingRoom.status !== 'waiting') {
      console.error('Game already started');
      return false;
    }

    // Create player
    const { data: player, error: playerError } = await supabase
      .from('players')
      .insert({
        name: playerName,
        room_id: existingRoom.id,
      })
      .select()
      .single();

    if (playerError || !player) {
      console.error('Failed to create player:', playerError);
      return false;
    }

    // Fetch all players in room
    const { data: roomPlayers } = await supabase
      .from('players')
      .select()
      .eq('room_id', existingRoom.id);

    setPlayerId(player.id);
    setRoom(existingRoom as GameRoom);
    setPlayers((roomPlayers as Player[]) || []);
    setIsHost(existingRoom.host_id === player.id);

    return true;
  }, []);

  const startGame = useCallback(async () => {
    if (!room?.id || !isHost) return;

    const event = getRandomEvent();

    await supabase
      .from('game_rooms')
      .update({
        status: 'playing',
        current_round: 1,
        current_event: JSON.stringify(event),
      })
      .eq('id', room.id);

    setCurrentEvent(event);
  }, [room?.id, isHost]);

  const nextRound = useCallback(async () => {
    if (!room?.id || !isHost) return;

    const event = getRandomEvent();

    // Reset all players' last_action
    await supabase
      .from('players')
      .update({ last_action: null })
      .eq('room_id', room.id);

    await supabase
      .from('game_rooms')
      .update({
        current_round: room.current_round + 1,
        current_event: JSON.stringify(event),
      })
      .eq('id', room.id);

    setCurrentEvent(event);
  }, [room?.id, room?.current_round, isHost]);

  const submitAction = useCallback(
    async (action: string, newCapital: number) => {
      if (!playerId) return;

      const isEliminated = newCapital <= 0;

      await supabase
        .from('players')
        .update({
          last_action: action,
          capital: newCapital,
          round: room?.current_round || 1,
          is_eliminated: isEliminated,
        })
        .eq('id', playerId);
    },
    [playerId, room?.current_round]
  );

  const leaveRoom = useCallback(async () => {
    if (playerId) {
      await supabase.from('players').delete().eq('id', playerId);
    }
    setRoom(null);
    setPlayers([]);
    setPlayerId(null);
    setIsHost(false);
    setCurrentEvent(null);
    channel?.unsubscribe();
  }, [playerId, channel]);

  const currentPlayer = players.find(p => p.id === playerId);
  const activePlayers = players.filter(p => !p.is_eliminated);
  const allPlayersActed = activePlayers.every(p => p.last_action !== null);

  return {
    room,
    players,
    playerId,
    currentPlayer,
    currentEvent,
    isHost,
    activePlayers,
    allPlayersActed,
    createRoom,
    joinRoom,
    startGame,
    nextRound,
    submitAction,
    leaveRoom,
  };
}
