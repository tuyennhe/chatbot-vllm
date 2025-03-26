// static/pdf_script.js
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const clearChatButton = document.getElementById('clear-chat-btn');
    const clearPdfButton = document.getElementById('clear-pdf-btn');
    const typingIndicator = document.getElementById('typing-indicator');
    const pdfUploadForm = document.getElementById('pdf-upload-form');
    const pdfFileInput = document.getElementById('pdf-file');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadStatus = document.getElementById('upload-status');
    const pdfInfoContent = document.getElementById('pdf-info-content');
    
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
    
    // Lấy thông tin PDF ban đầu
    fetchPdfInfo();
    
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
                 } else if (data.type === 'pdf_info') {
                     // Cập nhật thông tin PDF
                     updatePdfInfo(data.info);
                 } else if (data.type === 'pdf_upload_success') {
                     // Hiển thị thông báo tải lên thành công
                     uploadStatus.innerHTML = `<span class="status-success">✓ Đã tải lên thành công file ${data.file_name}</span>`;
                     uploadStatus.classList.add('status-success');
                     
                     // Cập nhật thông tin PDF
                     fetchPdfInfo();
                     
                     // Thêm thông báo vào chat
                     addMessageToUI('assistant', `Tôi đã xử lý file PDF "${data.file_name}" của bạn. Bạn có thể hỏi về nội dung của file này.`);
                     
                 } else if (data.type === 'pdf_upload_error') {
                     // Hiển thị thông báo lỗi
                     uploadStatus.innerHTML = `<span class="status-error">✗ Lỗi: ${data.message}</span>`;
                     uploadStatus.classList.add('status-error');
                 } else if (data.type === 'pdf_cleared') {
                     // Hiển thị thông báo xóa PDF thành công
                     pdfInfoContent.innerHTML = '<p>Chưa có file PDF nào được tải lên.</p>';
                     uploadStatus.innerHTML = '<span class="status-success">✓ Đã xóa toàn bộ dữ liệu PDF</span>';
                     uploadStatus.classList.add('status-success');
                     
                     // Thêm thông báo vào chat
                     addMessageToUI('assistant', 'Tôi đã xóa toàn bộ dữ liệu PDF. Bạn có thể tải lên file PDF mới.');
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
     
     /// Show welcome message
    function showWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = `
            <h2>Chào mừng đến với PDF ChatIN!</h2>
            <p>Tải lên file PDF của bạn và đặt câu hỏi về nội dung trong file. Tôi sẽ giúp bạn tìm hiểu thông tin từ tài liệu của bạn.</p>
        `;
    chatContainer.appendChild(welcomeDiv);
}

     
     // Lấy thông tin PDF
     function fetchPdfInfo() {
         if (websocket && websocket.readyState === WebSocket.OPEN) {
             websocket.send(JSON.stringify({
                 action: 'get_pdf_info'
             }));
         }
     }
     
     // Cập nhật thông tin PDF trong sidebar
     function updatePdfInfo(info) {
         if (info.total_files === 0) {
             pdfInfoContent.innerHTML = '<p>Chưa có file PDF nào được tải lên.</p>';
             return;
         }
         
         let html = `<p>Tổng số file: <strong>${info.total_files}</strong></p>`;
         html += `<p>Tổng số đoạn văn bản: <strong>${info.total_chunks}</strong></p>`;
         
         if (info.files && info.files.length > 0) {
             html += '<h4>Danh sách file:</h4>';
             html += '<ul class="pdf-file-list">';
             
             info.files.forEach(file => {
                 html += `
                     <li class="pdf-file-item">
                         <span class="pdf-file-icon">
                             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                 <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                 <polyline points="14 2 14 8 20 8"></polyline>
                                 <line x1="16" y1="13" x2="8" y2="13"></line>
                                 <line x1="16" y1="17" x2="8" y2="17"></line>
                                 <polyline points="10 9 9 9 8 9"></polyline>
                             </svg>
                         </span>
                         <div class="pdf-file-details">
                             <div class="pdf-file-name">${file.name}</div>
                             <div class="pdf-file-stats">
                                 ${file.pages} trang | ${file.chunks} đoạn văn bản
                             </div>
                         </div>
                     </li>
                 `;
             });
             
             html += '</ul>';
         }
         
         pdfInfoContent.innerHTML = html;
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
         
         // Kiểm tra nếu nội dung chứa code block
         if (originalContent.includes('```')) {
             // Xử lý code blocks và markdown
             renderFormattedContent(originalContent, currentStreamElement);
         } else {
             // Nếu không có code block, xử lý văn bản thông thường
             renderSimpleText(originalContent, currentStreamElement);
         }
         
         // Clear reference
         currentStreamElement = null;
         streamedContent = '';
         
         // Scroll to bottom
         scrollToBottom();
         
         // Giới hạn số lượng tin nhắn để tránh tràn bộ nhớ
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
     
     // Hàm xử lý code blocks
     function renderFormattedContent(content, container) {
         // Loại bỏ phần tham chiếu nếu có
         content = content.replace(/### Tham chiếu:[\s\S]*$/, '').trim();
         
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
                 const resultRegex = /# Kết quả: (.*)/g;
                 let resultMatch;
                 
                 if (segment.content.includes('# Kết quả:')) {
                     const resultDiv = document.createElement('div');
                     resultDiv.className = 'code-result';
                     resultDiv.textContent = segment.content.match(/# Kết quả: (.*)/)[1];
                     container.appendChild(resultDiv);
                 }
             } else {
                 // Render text thường với markdown
                 renderSimpleText(segment.content, container);
             }
         });
     }
     
     // Hàm xử lý văn bản thông thường
     // Hàm xử lý văn bản thông thường với hỗ trợ markdown
function renderSimpleText(text, container) {
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
                (para.includes('</h') || para.includes('</ul>') || para.includes('</ol>'))) {
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
     // Add a message to the UI (for non-streaming messages)
function addMessageToUI(role, content) {
    // Create message row
    const messageRow = document.createElement('div');
    messageRow.className = `message-row ${role}`;
    
    // Create message container
    const messageElement = document.createElement('div');
    messageElement.className = `message ${role}`;
    
    // Xử lý markdown trực tiếp
    if (content.includes('```')) {
        // Xử lý code blocks và markdown
        renderFormattedContent(content, messageElement);
    } else {
        // Nếu không có code block, xử lý văn bản thông thường với markdown
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
                 content: message,
                 action: 'pdf_query'
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
     
     // Clear PDF data
     function clearPdfData() {
         if (websocket && websocket.readyState === WebSocket.OPEN && !isStreaming) {
             websocket.send(JSON.stringify({
                 action: 'clear_pdf_data'
             }));
         }
     }
     
     // Upload PDF file
     function uploadPdf(file) {
         if (!file || file.type !== 'application/pdf') {
             uploadStatus.innerHTML = '<span class="status-error">✗ Lỗi: File không hợp lệ. Vui lòng chọn file PDF.</span>';
             uploadStatus.classList.add('status-error');
             return;
         }
         
         // Hiển thị thông báo đang tải lên
         uploadStatus.innerHTML = '<span class="status-pending">⟳ Đang tải lên và xử lý file...</span>';
         uploadStatus.classList.add('status-pending');
         
         // Xóa lịch sử chat khi tải lên file mới
         chatContainer.innerHTML = '';
         
         // Tạo form data
         const formData = new FormData();
         formData.append('pdf_file', file);
         formData.append('client_id', clientId);
         
         // Gửi file lên server
         fetch('/upload_pdf', {
             method: 'POST',
             body: formData
         })
         .then(response => response.json())
         .then(data => {
             if (data.status === 'success') {
                 uploadStatus.innerHTML = `<span class="status-success">✓ Đã tải lên thành công file ${data.file_name}</span>`;
                 uploadStatus.classList.add('status-success');
                 
                 // Cập nhật thông tin PDF
                 fetchPdfInfo();
                 
                 // Thêm thông báo vào chat
                 addMessageToUI('assistant', `Tôi đã xử lý file PDF "${data.file_name}" của bạn. File này có ${data.chunks} đoạn văn bản. Bạn có thể hỏi về nội dung của file này.`);
             } else {
                 uploadStatus.innerHTML = `<span class="status-error">✗ Lỗi: ${data.message}</span>`;
                 uploadStatus.classList.add('status-error');
             }
         })
         .catch(error => {
             console.error('Error uploading PDF:', error);
             uploadStatus.innerHTML = '<span class="status-error">✗ Lỗi khi tải lên file. Vui lòng thử lại.</span>';
             uploadStatus.classList.add('status-error');
         });
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
     clearPdfButton.addEventListener('click', clearPdfData);
     
     // Auto-resize textarea
     messageInput.addEventListener('input', () => {
         messageInput.style.height = 'auto';
         messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
         
         // Enable/disable send button based on input
         sendButton.disabled = messageInput.value.trim() === '' || isStreaming;
     });
     
     // Handle file upload
     pdfUploadForm.addEventListener('submit', (e) => {
         e.preventDefault();
         const file = pdfFileInput.files[0];
         if (file) {
             uploadPdf(file);
         } else {
             uploadStatus.innerHTML = '<span class="status-error">✗ Vui lòng chọn file PDF trước khi tải lên.</span>';
             uploadStatus.classList.add('status-error');
         }
     });
     
     // Update file input label when file is selected
     pdfFileInput.addEventListener('change', () => {
         const fileLabel = document.querySelector('.file-input-label');
         if (pdfFileInput.files.length > 0) {
             const fileName = pdfFileInput.files[0].name;
             fileLabel.textContent = fileName.length > 25 ? fileName.substring(0, 22) + '...' : fileName;
         } else {
             fileLabel.innerHTML = `
                 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                     <polyline points="17 8 12 3 7 8"></polyline>
                     <line x1="12" y1="3" x2="12" y2="15"></line>
                 </svg>
                 Chọn file PDF
             `;
         }
     });
     
     // Focus input field when page loads
     messageInput.focus();
 });
 