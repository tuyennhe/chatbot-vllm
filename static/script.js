// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const clearChatButton = document.getElementById('clear-chat-btn');
    const typingIndicator = document.getElementById('typing-indicator');
    
    // State
    let clientId = localStorage.getItem('clientId');
    let websocket = null;
    let currentStreamElement = null;
    let isStreaming = false;
    let streamedContent = ''; // Biến lưu trữ toàn bộ nội dung đang stream
    
    // Biến để theo dõi trạng thái kết nối
    let isReconnecting = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectInterval = 3000; // 3 giây
    
    // Biến để theo dõi streaming timeout
    let streamingTimeout = null;
    const MAX_STREAMING_TIME = 90000; // 90 giây (90000ms)
    
    // Generate a random client ID if not exists
    if (!clientId) {
        clientId = 'client_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('clientId', clientId);
    }
    
    // Initialize - Connect to websocket
    connectWebSocket();
    
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/${clientId}`;
        
        websocket = new WebSocket(wsUrl);
        
        websocket.onopen = (event) => {
            console.log('WebSocket connected');
            sendButton.disabled = false;
            isReconnecting = false;
            reconnectAttempts = 0;
            
            // Thêm thông báo kết nối lại nếu đang trong quá trình kết nối lại
            if (isReconnecting) {
                const reconnectMsg = document.createElement('div');
                reconnectMsg.className = 'system-message';
                reconnectMsg.textContent = 'Kết nối lại thành công!';
                chatContainer.appendChild(reconnectMsg);
                setTimeout(() => {
                    reconnectMsg.remove();
                }, 3000);
            }
            
            // Show welcome message if chat is empty
            if (chatContainer.children.length === 0) {
                showWelcomeMessage();
            }
            
            // Gửi heartbeat định kỳ để giữ kết nối
            startHeartbeat();
        };
        
        // Biến để theo dõi heartbeat
        let heartbeatInterval;
        
        // Hàm bắt đầu heartbeat
        function startHeartbeat() {
            // Xóa interval cũ nếu có
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }
            
            // Thiết lập heartbeat mới mỗi 15 giây thay vì 30 giây
            heartbeatInterval = setInterval(() => {
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    try {
                        websocket.send(JSON.stringify({
                            action: 'heartbeat'
                        }));
                        console.log('Heartbeat sent');
                    } catch (e) {
                        console.error('Error sending heartbeat:', e);
                        clearInterval(heartbeatInterval);
                        checkConnection();
                    }
                } else {
                    clearInterval(heartbeatInterval);
                    checkConnection();
                }
            }, 15000); // 15 giây
        }
        
        websocket.onmessage = (event) => {
            // Reset reconnect attempts on successful message
            reconnectAttempts = 0;
            
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'heartbeat_ack') {
                    console.log('Heartbeat acknowledged');
                    return;
                }
                
                if (data.type === 'stream_start') {
                    // Start a new streaming message
                    isStreaming = true;
                    streamedContent = '';
                    startStreamingMessage();
                    
                } else if (data.type === 'stream_chunk') {
                    // Add chunk to the current streaming message
                    appendStreamChunk(data.content);
                    
                } else if (data.type === 'stream_end') {
                    // Finalize the streaming message
                    isStreaming = false;
                    finishStreamingMessage();
                    
                } else if (data.type === 'error') {
                    // Handle error
                    console.error('Error from server:', data.message);
                    isStreaming = false;
                    typingIndicator.classList.add('hidden');
                    
                    // Clear streaming timeout
                    clearTimeout(streamingTimeout);
                    
                    // Show error message
                    addMessageToUI('assistant', 'Xin lỗi, tôi đang gặp vấn đề kỹ thuật. Vui lòng thử lại sau.');
                    scrollToBottom();
                    
                } else if (data.type === 'history_cleared') {
                    // Clear chat UI
                    chatContainer.innerHTML = '';
                    
                    // Show welcome message
                    showWelcomeMessage();
                }
            } catch (e) {
                console.error('Error parsing message:', e);
                // Nếu có lỗi parse JSON, có thể là do kết nối bị hỏng
                checkConnection();
            }
        };
        
        websocket.onclose = (event) => {
            console.log('WebSocket disconnected', event);
            sendButton.disabled = true;
            
            // Dừng heartbeat
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }
            
            // Nếu đang streaming thì kết thúc
            if (isStreaming) {
                isStreaming = false;
                if (currentStreamElement) {
                    appendStreamChunk("\n\n[Kết nối bị gián đoạn. Đang kết nối lại...]");
                    finishStreamingMessage();
                }
            }
            
            // Hiển thị thông báo mất kết nối
            if (!isReconnecting) {
                const disconnectMsg = document.createElement('div');
                disconnectMsg.className = 'system-message';
                disconnectMsg.textContent = 'Mất kết nối tới máy chủ. Đang kết nối lại...';
                chatContainer.appendChild(disconnectMsg);
                scrollToBottom();
            }
            
            // Tự động kết nối lại nếu chưa vượt quá số lần thử
            if (reconnectAttempts < maxReconnectAttempts) {
                isReconnecting = true;
                reconnectAttempts++;
                
                // Tăng thời gian chờ theo cấp số nhân
                const timeout = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1);
                console.log(`Attempting to reconnect in ${timeout}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
                
                setTimeout(connectWebSocket, timeout);
            } else {
                console.log('Max reconnect attempts reached');
                const failedMsg = document.createElement('div');
                failedMsg.className = 'system-message error';
                failedMsg.textContent = 'Không thể kết nối lại tới máy chủ. Vui lòng tải lại trang.';
                chatContainer.appendChild(failedMsg);
                
                // Thêm nút tải lại trang
                const reloadBtn = document.createElement('button');
                reloadBtn.className = 'reload-btn';
                reloadBtn.textContent = 'Tải lại trang';
                reloadBtn.onclick = () => window.location.reload();
                chatContainer.appendChild(reloadBtn);
                
                scrollToBottom();
            }
        };
        
        websocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            sendButton.disabled = true;
        };
    }
    
    // Hàm kiểm tra kết nối và kết nối lại nếu cần
    function checkConnection() {
        if (websocket === null || 
            websocket.readyState === WebSocket.CLOSED || 
            websocket.readyState === WebSocket.CLOSING) {
            
            if (!isReconnecting) {
                console.log('Connection lost, reconnecting...');
                
                // Nếu đang streaming thì kết thúc
                if (isStreaming) {
                    isStreaming = false;
                    if (currentStreamElement) {
                        appendStreamChunk("\n\n[Kết nối bị gián đoạn. Đang kết nối lại...]");
                        finishStreamingMessage();
                    }
                }
                
                // Hiển thị thông báo mất kết nối
                const disconnectMsg = document.createElement('div');
                disconnectMsg.className = 'system-message';
                disconnectMsg.textContent = 'Mất kết nối tới máy chủ. Đang kết nối lại...';
                chatContainer.appendChild(disconnectMsg);
                scrollToBottom();
                
                // Thêm nút khôi phục kết nối
                addReconnectButton();
                
                connectWebSocket();
            }
        }
    }
    
    // Thêm nút khôi phục kết nối
    function addReconnectButton() {
        // Kiểm tra nếu nút đã tồn tại
        if (document.getElementById('reconnect-btn')) return;
        
        const reconnectBtn = document.createElement('button');
        reconnectBtn.id = 'reconnect-btn';
        reconnectBtn.className = 'reconnect-btn';
        reconnectBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
            </svg>
            Khôi phục kết nối
        `;
        
        reconnectBtn.onclick = () => {
            // Xóa nút
            reconnectBtn.remove();
            
            // Hiển thị thông báo
            const reconnectingMsg = document.createElement('div');
            reconnectingMsg.className = 'system-message';
            reconnectingMsg.textContent = 'Đang khôi phục kết nối...';
            chatContainer.appendChild(reconnectingMsg);
            scrollToBottom();
            
            // Khởi tạo lại kết nối
            if (websocket) {
                websocket.close();
            }
            connectWebSocket();
            
            // Sau 3 giây, xóa thông báo đang kết nối lại
            setTimeout(() => {
                if (reconnectingMsg.parentNode === chatContainer) {
                    chatContainer.removeChild(reconnectingMsg);
                }
            }, 3000);
        };
        
        // Thêm vào header-actions
        document.querySelector('.header-actions').prepend(reconnectBtn);
    }
    
    // Kiểm tra kết nối mỗi 5 giây
    setInterval(checkConnection, 5000);
    
    // Show welcome message
    function showWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = `
            <h2>Chào mừng đến với ChatIN!</h2>
            <p>Tôi là trợ lý AI được phát triển bởi ATIN có thể giúp bạn trả lời câu hỏi, viết nội dung, giải thích khái niệm và nhiều việc khác. Hãy đặt câu hỏi để bắt đầu!</p>
        `;
        chatContainer.appendChild(welcomeDiv);
    }
    
    // Start a new streaming message
    function startStreamingMessage() {
        // Create message row
        const messageRow = document.createElement('div');
        messageRow.className = 'message-row';
        
        // Create message container
        const messageElement = document.createElement('div');
        messageElement.className = 'message assistant streaming';
        
        // Add to DOM
        messageRow.appendChild(messageElement);
        chatContainer.appendChild(messageRow);
        
        // Save reference to current streaming element
        currentStreamElement = messageElement;
        
        // Initialize with empty content
        updateStreamDisplay();
        
        // Hide typing indicator if visible
        typingIndicator.classList.add('hidden');
        
        // Scroll to bottom
        scrollToBottom();
        
        // Thiết lập timeout cho streaming
        clearTimeout(streamingTimeout);
        streamingTimeout = setTimeout(() => {
            if (isStreaming && currentStreamElement) {
                // Nếu vẫn đang streaming sau MAX_STREAMING_TIME, thì kết thúc và hiển thị thông báo timeout
                appendStreamChunk("\n\n[Đã quá thời gian chờ. Kết nối có thể bị gián đoạn. Vui lòng thử lại.]");
                finishStreamingMessage();
                isStreaming = false;
                
                // Hiển thị thông báo lỗi
                const timeoutMsg = document.createElement('div');
                timeoutMsg.className = 'system-message error';
                timeoutMsg.textContent = 'Phản hồi quá lâu. Kết nối có thể bị gián đoạn. Vui lòng thử lại.';
                chatContainer.appendChild(timeoutMsg);
                scrollToBottom();
                
                // Thử kết nối lại
                checkConnection();
            }
        }, MAX_STREAMING_TIME);
    }
    
    // Append a chunk to the streaming message
    function appendStreamChunk(chunk) {
        if (!currentStreamElement) return;
        
        // Thêm chunk vào nội dung đã stream
        streamedContent += chunk;
        
        // Cập nhật hiển thị
        updateStreamDisplay();
        
        // Scroll to bottom
        scrollToBottom();
    }
    
    // Cập nhật hiển thị stream
    function updateStreamDisplay() {
        if (!currentStreamElement) return;
        
        // Hiển thị toàn bộ nội dung đã stream
        currentStreamElement.textContent = streamedContent;
        
        // Thêm cursor nhấp nháy
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        currentStreamElement.appendChild(cursor);
    }
    
    // Finish the streaming message
    function finishStreamingMessage() {
        // Xóa timeout khi hoàn thành streaming
        clearTimeout(streamingTimeout);
        
        if (!currentStreamElement) return;
        
        // Remove streaming class
        currentStreamElement.classList.remove('streaming');
        
        // Lưu nội dung gốc
        const originalContent = streamedContent;
        
        // Xóa nội dung hiện tại để áp dụng định dạng
        currentStreamElement.innerHTML = '';
        
        // Kiểm tra nếu nội dung chứa code block hoặc biểu thức toán học
        if (originalContent.includes('```') || originalContent.includes('\\(') || originalContent.includes('\\[')) {
            // Xử lý code blocks, markdown và biểu thức toán học
            renderFormattedContent(originalContent, currentStreamElement);
        } else {
            // Nếu không có code block hay biểu thức toán học, xử lý văn bản thông thường
            renderSimpleText(originalContent, currentStreamElement);
        }
        
        // Clear reference
        currentStreamElement = null;
        streamedContent = '';
        
        // Scroll to bottom
        scrollToBottom();
        
        // Giới hạn số lượng tin nhắn
        limitChatMessages();
    }
    
    // Giới hạn số lượng tin nhắn
    function limitChatMessages() {
        const maxMessages = 50; // Giới hạn 50 tin nhắn
        const messageRows = chatContainer.querySelectorAll('.message-row');
        
        if (messageRows.length > maxMessages) {
            // Giữ lại tin nhắn mới nhất
            const messagesToRemove = messageRows.length - maxMessages;
            for (let i = 0; i < messagesToRemove; i++) {
                chatContainer.removeChild(messageRows[i]);
            }
            
            // Thêm thông báo đã xóa tin nhắn cũ
            const noticeDiv = document.createElement('div');
            noticeDiv.className = 'system-message';
            noticeDiv.textContent = `${messagesToRemove} tin nhắn cũ đã được ẩn để tối ưu hiệu suất.`;
            chatContainer.insertBefore(noticeDiv, chatContainer.firstChild);
            
            // Tự động xóa thông báo sau 5 giây
            setTimeout(() => {
                if (noticeDiv.parentNode === chatContainer) {
                    chatContainer.removeChild(noticeDiv);
                }
            }, 5000);
        }
    }
    
    // Hàm xử lý code blocks và biểu thức toán học
    function renderFormattedContent(content, container) {
        // Xử lý các biểu thức toán học dạng block trước
        if (content.includes('\\[') && content.includes('\\]')) {
            const mathBlockRegex = /\\?\\\[([\s\S]*?)\\?\\\]/g;
            content = content.replace(mathBlockRegex, '<div class="formula">$1</div>');
        }
        
        // Xử lý các biểu thức toán học dạng inline
        if (content.includes('\\(') && content.includes('\\)')) {
            const mathInlineRegex = /\\?\\\(([\s\S]*?)\\?\\\)/g;
            content = content.replace(mathInlineRegex, '<span class="math-inline">$1</span>');
        }
        
        // Xử lý các ký hiệu toán học phổ biến
        content = content.replace(/\\times/g, '<span class="times">×</span>');
        content = content.replace(/\\cdot/g, '<span class="times">·</span>');
        
        // Tách nội dung thành các phần: code blocks và text thường
        let segments = [];
        let currentPos = 0;
        
        // Tìm tất cả code blocks
        const codeBlockRegex = /```(\w*)\n([\s\S]*?)\n```/g;
        let match;
        
        while ((match = codeBlockRegex.exec(content)) !== null) {
            // Nếu có text trước code block, thêm vào segments
            if (match.index > currentPos) {
                segments.push({
                    type: 'text',
                    content: content.substring(currentPos, match.index)
                });
            }
            
            // Thêm code block vào segments
            segments.push({
                type: 'code',
                language: match[1],
                content: match[2]
            });
            
            currentPos = match.index + match[0].length;
        }
        
        // Nếu còn text sau code block cuối cùng
        if (currentPos < content.length) {
            segments.push({
                type: 'text',
                content: content.substring(currentPos)
            });
        }
        
        // Nếu không tìm thấy code block nào
        if (segments.length === 0) {
            segments.push({
                type: 'text',
                content: content
            });
        }
        
        // Render từng segment
        segments.forEach(segment => {
            if (segment.type === 'code') {
                // Render code block
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                
                if (segment.language) {
                    code.className = segment.language;
                }
                
                code.textContent = segment.content;
                pre.appendChild(code);
                container.appendChild(pre);
                
                // Nếu có kết quả đi kèm với code block, hiển thị kết quả
                // Tìm dòng có "# Kết quả:" trong code block
                if (segment.content.includes('# Kết quả:')) {
                    const resultDiv = document.createElement('div');
                    resultDiv.className = 'code-result';
                    resultDiv.textContent = segment.content.match(/# Kết quả: (.*)/)[1];
                    container.appendChild(resultDiv);
                }
            } else {
                // Render text thường với markdown và toán học
                renderSimpleText(segment.content, container);
            }
        });
    }
    
    // Hàm xử lý văn bản thường với hỗ trợ markdown và toán học
    function renderSimpleText(text, container) {
        // Xử lý các biểu thức toán học dạng inline: \(x \times y = 0\)
        text = text.replace(/\\?\\\((.*?)\\?\\\)/g, '<span class="math-inline">$1</span>');
        
        // Xử lý các biểu thức toán học dạng block: \[x + y = 8\]
        text = text.replace(/\\?\\\[(.*?)\\?\\\]/g, '<div class="formula">$1</div>');
        
        // Xử lý các ký hiệu toán học phổ biến
        text = text.replace(/\\times/g, '<span class="times">×</span>');
        text = text.replace(/\\cdot/g, '<span class="times">·</span>');
        
        // Cẩn thận với các ký tự đặc biệt - tránh thay thế trong code hoặc biểu thức toán học
        // Tạm thời không thay thế dấu =, +, - trực tiếp để tránh ảnh hưởng đến code
        // text = text.replace(/=/g, '<span class="equals">=</span>');
        // text = text.replace(/\+/g, '<span class="plus">+</span>');
        // text = text.replace(/-/g, '<span class="minus">-</span>');
        
        // Xử lý các tiêu đề markdown (h1, h2, h3, etc.)
        const headingPattern = /^(#{1,6})\s+(.+)$/gm;
        text = text.replace(headingPattern, (match, hashes, content) => {
            const level = hashes.length;
            return `<h${level}>${content}</h${level}>`;
        });
        
        // Xử lý danh sách không thứ tự
        text = text.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
        text = text.replace(/<li>(.+)<\/li>(\n<li>(.+)<\/li>)+/g, '<ul>$&</ul>');
        
        // Xử lý danh sách có thứ tự
        text = text.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
        text = text.replace(/<li>(.+)<\/li>(\n<li>(.+)<\/li>)+/g, match => {
            if (match.startsWith('<ul>')) return match;
            return '<ol>' + match + '</ol>';
        });
        
        // Xử lý đoạn text in đậm
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Xử lý đoạn text in nghiêng
        text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        
        // Xử lý inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Tách thành các đoạn
        const paragraphs = text.split('\n\n');
        
        paragraphs.forEach(para => {
            if (para.trim()) {
                // Kiểm tra nếu đoạn văn bản đã là HTML (bắt đầu bằng thẻ HTML)
                if (para.trim().startsWith('<') && 
                    (para.includes('</h') || para.includes('</ul>') || para.includes('</ol>') || 
                     para.includes('class="formula"'))) {
                    const div = document.createElement('div');
                    div.innerHTML = para;
                    container.appendChild(div);
                } else {
                    const p = document.createElement('p');
                    
                    // Xử lý xuống dòng trong đoạn
                    const lines = para.split('\n');
                    lines.forEach((line, i) => {
                        if (i > 0) {
                            p.appendChild(document.createElement('br'));
                        }
                        
                        // Nếu có HTML tags
                        if (line.includes('<') && line.includes('>')) {
                            const span = document.createElement('span');
                            span.innerHTML = line;
                            p.appendChild(span);
                        } else {
                            p.appendChild(document.createTextNode(line));
                        }
                    });
                    
                    container.appendChild(p);
                }
            }
        });
    }
    
    // Add a message to the UI (for non-streaming messages)
    function addMessageToUI(role, content) {
        // Create message row
        const messageRow = document.createElement('div');
        messageRow.className = `message-row ${role}`;
        
        // Create message container
        const messageElement = document.createElement('div');
        messageElement.className = `message ${role}`;
        
        // Xử lý markdown và toán học
        if (content.includes('```') || content.includes('\\(') || content.includes('\\[')) {
            // Xử lý code blocks, markdown và biểu thức toán học
            renderFormattedContent(content, messageElement);
        } else {
            // Nếu không có code block hay biểu thức toán học, xử lý văn bản thông thường
            renderSimpleText(content, messageElement);
        }
        
        messageRow.appendChild(messageElement);
        chatContainer.appendChild(messageRow);
        
        // Hide welcome message if exists
        const welcomeMessage = document.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
        
        // Giới hạn số lượng tin nhắn
        limitChatMessages();
    }
    
    // Escape HTML characters to prevent XSS
    function escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    
    // Scroll to bottom of chat container
    function scrollToBottom() {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    // Send message
    function sendMessage() {
        const message = messageInput.value.trim();
        
        if (message && websocket && websocket.readyState === WebSocket.OPEN && !isStreaming) {
            // Hide welcome message if exists
            const welcomeMessage = document.querySelector('.welcome-message');
            if (welcomeMessage) {
                welcomeMessage.remove();
            }
            
            // Add user message to UI
            addMessageToUI('user', message);
            
            // Show typing indicator
            typingIndicator.classList.remove('hidden');
            scrollToBottom();
            
            // Send message to server
            websocket.send(JSON.stringify({
                content: message
            }));
            
            // Clear input
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }
    }
    
    // Clear chat history
    function clearChat() {
        if (websocket && websocket.readyState === WebSocket.OPEN && !isStreaming) {
            websocket.send(JSON.stringify({
                action: 'clear_history'
            }));
        }
    }
    
    // Event listeners
    sendButton.addEventListener('click', sendMessage);
    
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    clearChatButton.addEventListener('click', clearChat);
    
    // Auto-resize textarea
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
        
        // Enable/disable send button based on input
        sendButton.disabled = messageInput.value.trim() === '' || isStreaming;
    });
    
    // Focus input field when page loads
    messageInput.focus();
});
